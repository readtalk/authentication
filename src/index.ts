import { issuer } from "@openauthjs/openauth";
import {
	CloudflareStorage,
	type CloudflareStorageOptions,
} from "@openauthjs/openauth/storage/cloudflare";
import { PasswordProvider } from "@openauthjs/openauth/provider/password";
import { PasswordUI } from "@openauthjs/openauth/ui/password";
import { createSubjects } from "@openauthjs/openauth/subject";
import { object, string } from "valibot";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { UpdateListHandler } from "./authentication/update";

export { Authentication } from "./authentication/auth";
export { Room } from "./authentication/room";

const subjects = createSubjects({
	user: object({
		id: string(),
		email: string(),
	}),
});

const app = new Hono();
app.use('*', cors({
	origin: '*',
	allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
	allowHeaders: ['Content-Type', 'Authorization', 'X-User-Id', 'X-Session-Id', 'X-Chat-Id'],
}));

app.get('/users', async (c) => {
	const users = await c.env.DATA_DB.prepare(
		`SELECT * FROM user`
	).all();
	return c.json({ success: true, users: users.results });
});

app.get('/users/:username', async (c) => {
	const username = c.req.param('username');
	
	let viewerId = '';
	const authHeader = c.req.header('Authorization');
	if (authHeader && authHeader.startsWith('Bearer ')) {
		try {
			const token = authHeader.replace('Bearer ', '');
			const payloadBase64 = token.split(".")[1];
			const payload = JSON.parse(atob(payloadBase64));
			viewerId = payload.properties?.id || payload.sub || '';
		} catch (e) {
			// Abaikan jika token tidak valid
		}
	}
	
	const user = await c.env.DATA_DB.prepare(
		`SELECT * FROM user WHERE username = ?`
	).bind(username).first();

	if (!user) return c.json({ success: false, error: "User not found" }, 404);

	const updates = await c.env.DATA_DB.prepare(
		`
		SELECT 
			u.id,
			u.user_id,
			u.content,
			u.image_url,
			u.created_at,
			'original' as type,
			NULL as reposter_id,
			u_user.username as author_username,
			u_user.yourname as author_yourname,
			u_user.avatar as author_avatar,
			(SELECT COUNT(*) FROM updatelist_like ul WHERE ul.updatelist_id = u.id) as like_count,
			(SELECT COUNT(*) FROM updatelist_comment uc WHERE uc.updatelist_id = u.id) as comment_count,
			(SELECT COUNT(*) FROM updatelist_repost ur WHERE ur.updatelist_id = u.id) as repost_count,
			EXISTS(SELECT 1 FROM updatelist_like ul WHERE ul.updatelist_id = u.id AND ul.user_id = ?) as is_liked,
			EXISTS(SELECT 1 FROM updatelist_repost ur WHERE ur.updatelist_id = u.id AND ur.user_id = ?) as is_reposted
		FROM updatelist u 
		LEFT JOIN user u_user ON u.user_id = u_user.id
		WHERE u.user_id = ?

		UNION ALL

		SELECT 
			u.id,
			u.user_id,
			u.content,
			u.image_url,
			ur.created_at as created_at,
			'repost' as type,
			ur.user_id as reposter_id,
			u_user.username as author_username,
			u_user.yourname as author_yourname,
			u_user.avatar as author_avatar,
			(SELECT COUNT(*) FROM updatelist_like ul WHERE ul.updatelist_id = u.id) as like_count,
			(SELECT COUNT(*) FROM updatelist_comment uc WHERE uc.updatelist_id = u.id) as comment_count,
			(SELECT COUNT(*) FROM updatelist_repost ur2 WHERE ur2.updatelist_id = u.id) as repost_count,
			EXISTS(SELECT 1 FROM updatelist_like ul WHERE ul.updatelist_id = u.id AND ul.user_id = ?) as is_liked,
			EXISTS(SELECT 1 FROM updatelist_repost ur2 WHERE ur2.updatelist_id = u.id AND ur2.user_id = ?) as is_reposted
		FROM updatelist_repost ur
		INNER JOIN updatelist u ON ur.updatelist_id = u.id
		LEFT JOIN user u_user ON u.user_id = u_user.id
		WHERE ur.user_id = ?

		ORDER BY created_at DESC
		`
	).bind(viewerId, viewerId, user.id, viewerId, viewerId, user.id).all();

	return c.json({ 
		success: true, 
		user: {
			...user,
			updates: updates.results
		} 
	});
});

app.get('/users/online', async (c) => {
	const id = c.env.DATA_DO.idFromName('default');
	const stub = c.env.DATA_DO.get(id);

	const doUrl = new URL('https://do/users/online');
	return stub.fetch(doUrl.toString());
});

app.all('/ws', async (c) => {
	const token = c.req.query('token');
	if (!token) return c.json({ error: "Token required" }, 401);

	try {
		const payloadBase64 = token.split(".")[1];
		const payload = JSON.parse(atob(payloadBase64));
		const userId = payload.properties?.id || payload.sub;

		if (!userId) return c.json({ error: "Invalid token" }, 401);

		const id = c.env.DATA_DO.idFromName('default');
		const stub = c.env.DATA_DO.get(id);

		const doUrl = new URL('https://do/ws');
		doUrl.searchParams.set('userId', userId);

		return stub.fetch(doUrl.toString(), c.req.raw);
	} catch (error) {
		return c.json({ error: "Invalid token" }, 401);
	}
});

app.all('/chats/*', async (c) => {
	const authHeader = c.req.header("Authorization");
	if (!authHeader || !authHeader.startsWith("Bearer ")) {
		return c.json({ success: false, error: "Unauthorized" }, 401);
	}
	const token = authHeader.replace("Bearer ", "");
	const payload = JSON.parse(atob(token.split(".")[1]));
	const userId = payload.properties?.id || payload.sub;

	const pathParts = c.req.path.split('/');
	const isMessageRoute = pathParts.includes('messages') || pathParts.includes('upload');

	if (isMessageRoute) {
		const chatId = pathParts[2];
		if (!chatId) return c.json({ success: false, error: "Chat ID required" }, 400);

		const id = c.env.ROOM_DO.idFromName(`room-${chatId}`);
		const stub = c.env.ROOM_DO.get(id);

		const newHeaders = new Headers(c.req.raw.headers);
		newHeaders.set("X-User-Id", userId);
		newHeaders.set("X-Chat-Id", chatId);

		const doUrl = new URL('https://do' + c.req.path.replace(`/chats/${chatId}`, '/chats'));
		doUrl.search = c.req.url.split('?')[1] || '';

		const newRequest = new Request(doUrl.toString(), {
			method: c.req.method,
			headers: newHeaders,
			body: c.req.raw.body
		});

		return stub.fetch(newRequest);
	} else {
		const id = c.env.DATA_DO.idFromName('default');
		const stub = c.env.DATA_DO.get(id);

		const doUrl = new URL('https://do' + c.req.path);
		doUrl.search = c.req.url.split('?')[1] || '';

		const newHeaders = new Headers(c.req.raw.headers);
		newHeaders.set("X-User-Id", userId);

		const newRequest = new Request(doUrl.toString(), {
			method: c.req.method,
			headers: newHeaders,
			body: c.req.raw.body
		});

		return stub.fetch(newRequest);
	}
});

app.get('/settings', async (c) => {
	const authHeader = c.req.header("Authorization");
	if (!authHeader || !authHeader.startsWith("Bearer ")) {
		return c.json({ success: false, error: "Unauthorized" }, 401);
	}

	const token = authHeader.replace("Bearer ", "");

	try {
		const payloadBase64 = token.split(".")[1];
		const payload = JSON.parse(atob(payloadBase64));
		const userId = payload.properties?.id || payload.sub;

		if (!userId) {
			return c.json({ success: false, error: "Invalid token" }, 401);
		}

		const user = await c.env.DATA_DB.prepare(
			`SELECT * FROM user WHERE id = ?`
		).bind(userId).first();

		if (!user) {
			return c.json({ success: false, error: "User not found" }, 404);
		}

		return c.json({ success: true, user });
	} catch (error) {
		console.error("Settings fetch error:", error);
		return c.json({ success: false, error: "Failed to fetch settings" }, 500);
	}
});

app.post('/settings', async (c) => {
	const authHeader = c.req.header("Authorization");
	if (!authHeader || !authHeader.startsWith("Bearer ")) {
		return c.json({ success: false, error: "Unauthorized" }, 401);
	}

	const token = authHeader.replace("Bearer ", "");

	try {
		const payloadBase64 = token.split(".")[1];
		const payload = JSON.parse(atob(payloadBase64));
		const userId = payload.properties?.id || payload.sub;

		if (!userId) {
			return c.json({ success: false, error: "Invalid token" }, 401);
		}

		const { username, yourname, date_of_birth, avatar, header, headline, about, socials, location } = await c.req.json();

		if (!username || !yourname || !date_of_birth) {
			return c.json({ success: false, error: "Username, yourname, and date_of_birth are required" }, 400);
		}

		const usernameRegex = /^[A-Za-z0-9_]{1,14}$/;
		if (!usernameRegex.test(username)) {
			return c.json({ success: false, error: "Username must be 1-14 characters, only A-Z, 0-9, and underscore" }, 400);
		}

		await c.env.DATA_DB.prepare(
			`UPDATE user SET username = ?, yourname = ?, date_of_birth = ?, avatar = ?, header = ?, headline = ?, about = ?, socials = ?, location = ? WHERE id = ?`
		).bind(
			username, 
			yourname, 
			date_of_birth, 
			avatar || null, 
			header || null, 
			headline || null, 
			about || null, 
			socials || null, 
			location || null, 
			userId
		).run();

		return c.json({ success: true });
	} catch (error) {
		console.error("Settings update error:", error);
		return c.json({ success: false, error: "Failed to update settings" }, 500);
	}
});

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext) {
		const url = new URL(request.url);

		if (request.method === 'OPTIONS') {
			return new Response(null, {
				status: 204,
				headers: {
					'Access-Control-Allow-Origin': '*',
					'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
					'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-User-Id, X-Session-Id, X-Chat-Id',
				}
			});
		}

		if (url.pathname.startsWith('/updates')) {
			const authHeader = request.headers.get("Authorization");
			if (!authHeader || !authHeader.startsWith("Bearer ")) {
				return new Response(JSON.stringify({ success: false, error: "Unauthorized" }), { 
					status: 401, 
					headers: { "Content-Type": "application/json" } 
				});
			}

			const token = authHeader.replace("Bearer ", "");
			try {
				const payloadBase64 = token.split(".")[1];
				const payload = JSON.parse(atob(payloadBase64));
				const userId = payload.properties?.id || payload.sub;

				if (!userId) {
					return new Response(JSON.stringify({ success: false, error: "Invalid token" }), { 
						status: 401, 
						headers: { "Content-Type": "application/json" } 
					});
				}

				const newHeaders = new Headers(request.headers);
				newHeaders.set("X-User-Id", userId);

				const newRequest = new Request(request.url, {
					method: request.method,
					headers: newHeaders,
					body: request.body
				});

				const updateList = new UpdateListHandler(env);
				return updateList.getApp().fetch(newRequest);
			} catch (error) {
				return new Response(JSON.stringify({ success: false, error: "Invalid token" }), { 
					status: 401, 
					headers: { "Content-Type": "application/json" } 
				});
			}
		}

		if (url.pathname.startsWith('/users') || url.pathname === '/ws' || url.pathname === '/settings' || url.pathname.startsWith('/chats')) {
			return app.fetch(request, env, ctx);
		}

		if (url.pathname === "/") {
			url.searchParams.set("redirect_uri", url.origin + "/callback");
			url.searchParams.set("client_id", "your-client-id");
			url.searchParams.set("response_type", "code");
			url.pathname = "/authorize";
			return Response.redirect(url.toString());
		} else if (url.pathname === "/callback") {
			return Response.json({
				message: "OAuth flow complete!",
				params: Object.fromEntries(url.searchParams.entries()),
			});
		}

		return issuer({
			storage: CloudflareStorage({
				namespace: env.DATA_KV as CloudflareStorageOptions["namespace"],
			}),
			subjects,
			providers: {
				password: PasswordProvider(
					PasswordUI({
						sendCode: async (email, code) => {
							console.log(`Sending code ${code} to ${email}`);
						},
						copy: {
							input_code: "Code (check Worker logs)",
						},
					}),
				),
			},
			theme: {
				title: "Authentication",
				primary: "#000000",
				favicon: "https://raw.githubusercontent.com/readtalk/asean/refs/heads/main/public/favicon.ico",
				logo: {
					dark: "https://raw.githubusercontent.com/readtalk/global/refs/heads/main/public/logo-dark.png",
					light:
						"https://raw.githubusercontent.com/readtalk/global/refs/heads/main/public/logo-dark.png",
				},
			},
			success: async (ctx, value) => {
				const userID = await getOrCreateUser(env, value.email);

				const id = env.DATA_DO.idFromName('default');
				const stub = env.DATA_DO.get(id);

				await (stub as any).syncUserId(userID);

				return ctx.subject("user", {
					id: userID,
					email: value.email,
				});
			},
		}).fetch(request, env, ctx);
	},
} satisfies ExportedHandler<Env>;

async function getOrCreateUser(env: Env, email: string): Promise<string> {
	const result = await env.DATA_DB.prepare(
		`
		INSERT INTO user (email)
		VALUES (?)
		ON CONFLICT (email) DO UPDATE SET email = email
		RETURNING id;
		`,
	)
		.bind(email)
		.first<{ id: string }>();
	if (!result) {
		throw new Error(`Unable to process user: ${email}`);
	}
	console.log(`Found or created user ${result.id} with email ${email}`);
	return result.id;
}
