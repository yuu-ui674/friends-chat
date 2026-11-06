// 部屋ごとのリアルタイム通信を受け持つ Durable Object です。
// - ブラウザとの WebSocket 接続を預かります。
// - Worker（index.js）から「このメッセージを配って」と頼まれたら、つながっている全員に送ります。
// メッセージの保存・ログイン確認は index.js 側で済んでいるので、ここでは行いません。
import { DurableObject } from 'cloudflare:workers';

export class ChatRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    // ブラウザから 'ping' が来たら 'pong' を自動で返します（接続の生存確認用）
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }

  async fetch(request) {
    // 1) ブラウザからの WebSocket 接続
    if (request.headers.get('Upgrade') === 'websocket') {
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      this.ctx.acceptWebSocket(server);
      return new Response(null, { status: 101, webSocket: client });
    }

    // 2) Worker からの「全員に配って」という依頼
    const url = new URL(request.url);
    if (request.method === 'POST' && url.pathname === '/broadcast') {
      const payload = await request.text();
      for (const socket of this.ctx.getWebSockets()) {
        try {
          socket.send(payload);
        } catch (err) {
          // 送れなかった接続は、そのうち切れるのでここでは何もしません
        }
      }
      return new Response('ok');
    }

    return new Response('Not found', { status: 404 });
  }

  // ブラウザから来る 'ping' 以外の通信は、今のところ使いません
  webSocketMessage(ws, message) {}

  webSocketClose(ws, code, reason) {
    try {
      ws.close(code, reason);
    } catch (err) {
      // すでに閉じている場合は何もしません
    }
  }

  webSocketError(ws, error) {
    try {
      ws.close(1011, 'error');
    } catch (err) {
      // すでに閉じている場合は何もしません
    }
  }
}
