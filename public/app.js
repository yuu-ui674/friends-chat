// 友達チャット: ブラウザ側のプログラム
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const VIEWS = ['view-loading', 'view-auth', 'view-password', 'view-chat'];

  const state = {
    user: null,
    rooms: [],
    roomId: null,
    selectToken: 0,
    messages: [],
    knownIds: new Set(),
    hasMore: false,
    loadingOlder: false,
    sending: false,
    ws: null,
    reconnectTimer: null,
    reconnectDelay: 1000,
    pingTimer: null,
    lastPong: 0,
    noticeTimer: null,
    passwordForced: false,
  };

  class ApiError extends Error {
    constructor(message, status, code) {
      super(message);
      this.status = status;
      this.code = code;
    }
  }

  // ---------------------------------------------------------------------
  // サーバーとの通信
  // ---------------------------------------------------------------------

  async function api(path, options = {}) {
    const init = { method: options.method || 'GET', headers: {}, credentials: 'same-origin' };
    if (options.body !== undefined) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(options.body);
    }

    let res;
    try {
      res = await fetch(path, init);
    } catch (err) {
      throw new ApiError('通信に失敗しました。ネットワークを確認してください。', 0, 'network');
    }

    let data = null;
    try {
      data = await res.json();
    } catch (err) {
      data = null;
    }

    if (!res.ok) {
      const code = data && data.code;
      if (res.status === 401 && state.user) {
        handleSessionExpired();
      } else if (res.status === 403 && code === 'password_change_required' && state.user) {
        state.user.mustChangePassword = true;
        showPasswordView(true);
      }
      throw new ApiError((data && data.error) || 'エラーが発生しました。', res.status, code);
    }
    return data;
  }

  // ---------------------------------------------------------------------
  // 画面の切り替え・共通の道具
  // ---------------------------------------------------------------------

  function showView(id) {
    for (const view of VIEWS) $(view).hidden = view !== id;
    if (id !== 'view-chat') {
      const dialog = $('admin-dialog');
      if (dialog.open) dialog.close();
    }
  }

  function setMessage(element, text, kind) {
    element.textContent = text || '';
    element.className = 'message' + (kind ? ` ${kind}` : '');
  }

  async function withBusy(form, task) {
    const buttons = form.querySelectorAll('button');
    buttons.forEach((b) => {
      b.disabled = true;
    });
    try {
      return await task();
    } finally {
      buttons.forEach((b) => {
        b.disabled = false;
      });
    }
  }

  function resetState() {
    closeWs();
    state.user = null;
    state.rooms = [];
    state.roomId = null;
    state.selectToken += 1;
    state.messages = [];
    state.knownIds = new Set();
    state.hasMore = false;
    state.loadingOlder = false;
    state.sending = false;
    state.reconnectDelay = 1000;
    $('messages').replaceChildren();
    $('input').value = '';
    clearNotice();
  }

  function handleSessionExpired() {
    resetState();
    showAuthTab('login');
    showView('view-auth');
    setMessage($('login-message'), 'ログインの有効期限が切れました。もう一度ログインしてください。', 'error');
  }

  // ---------------------------------------------------------------------
  // ログイン・新規登録・管理者の回復
  // ---------------------------------------------------------------------

  function showAuthTab(name) {
    for (const tab of ['login', 'register', 'recover']) {
      $(`form-${tab}`).hidden = tab !== name;
    }
    $('auth-tabs').hidden = name === 'recover';
    $('recover-link-area').hidden = name === 'recover';
    $('tab-login').classList.toggle('active', name === 'login');
    $('tab-register').classList.toggle('active', name === 'register');
    for (const id of ['login-message', 'register-message', 'recover-message']) setMessage($(id), '');
  }

  document.querySelectorAll('#auth-tabs .tab').forEach((tab) => {
    tab.addEventListener('click', () => showAuthTab(tab.dataset.tab));
  });
  $('link-recover').addEventListener('click', () => showAuthTab('recover'));
  $('link-back-login').addEventListener('click', () => showAuthTab('login'));

  $('form-login').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const message = $('login-message');
    setMessage(message, '');
    await withBusy(form, async () => {
      try {
        const data = await api('/api/login', {
          method: 'POST',
          body: { username: $('login-username').value.trim(), password: $('login-password').value },
        });
        $('login-password').value = '';
        await startSession(data.user);
      } catch (err) {
        setMessage(message, err.message, 'error');
      }
    });
  });

  $('form-register').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const message = $('register-message');
    setMessage(message, '');
    await withBusy(form, async () => {
      try {
        const data = await api('/api/register', {
          method: 'POST',
          body: {
            username: $('register-username').value.trim(),
            password: $('register-password').value,
            inviteCode: $('register-invite').value.trim(),
          },
        });
        $('register-password').value = '';
        $('register-invite').value = '';
        await startSession(data.user);
      } catch (err) {
        setMessage(message, err.message, 'error');
      }
    });
  });

  $('form-recover').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const message = $('recover-message');
    setMessage(message, '');
    await withBusy(form, async () => {
      try {
        await api('/api/admin/recover', {
          method: 'POST',
          body: { recoveryCode: $('recover-code').value, newPassword: $('recover-password').value },
        });
        $('recover-code').value = '';
        $('recover-password').value = '';
        showAuthTab('login');
        setMessage($('login-message'), '管理者のパスワードを再設定しました。新しいパスワードでログインしてください。', 'ok');
      } catch (err) {
        setMessage(message, err.message, 'error');
      }
    });
  });

  async function startSession(user) {
    state.user = user;
    if (user.mustChangePassword) {
      showPasswordView(true);
    } else {
      await enterChat();
    }
  }

  async function logout() {
    try {
      await api('/api/logout', { method: 'POST', body: {} });
    } catch (err) {
      // 通信に失敗しても、この端末ではログアウト状態にします
    }
    resetState();
    showAuthTab('login');
    showView('view-auth');
  }

  $('btn-logout').addEventListener('click', logout);
  $('btn-password-logout').addEventListener('click', logout);

  // ---------------------------------------------------------------------
  // パスワード変更
  // ---------------------------------------------------------------------

  function showPasswordView(forced) {
    state.passwordForced = forced;
    $('form-password').reset();
    setMessage($('password-message'), '');
    $('password-title').textContent = forced ? '新しいパスワードを決めてください' : 'パスワードの変更';
    $('password-note').textContent = forced
      ? '管理者がパスワードを初期化しました。教えてもらった一時パスワードを「今のパスワード」に入力して、自分だけのパスワードに変更してください。'
      : '';
    $('btn-password-cancel').hidden = forced;
    $('btn-password-logout').hidden = !forced;
    showView('view-password');
  }

  $('btn-change-password').addEventListener('click', () => {
    closeSidebar();
    showPasswordView(false);
  });
  $('btn-password-cancel').addEventListener('click', () => showView('view-chat'));

  $('form-password').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const message = $('password-message');
    setMessage(message, '');
    const newPassword = $('pw-new').value;
    if (newPassword !== $('pw-confirm').value) {
      setMessage(message, '新しいパスワードが一致しません。', 'error');
      return;
    }
    await withBusy(form, async () => {
      try {
        const data = await api('/api/change-password', {
          method: 'POST',
          body: { currentPassword: $('pw-current').value, newPassword },
        });
        form.reset();
        const wasForced = state.passwordForced;
        state.user = data.user;
        if (wasForced) {
          await enterChat();
        } else {
          showView('view-chat');
          showNotice('パスワードを変更しました。', 'ok', 4000);
        }
      } catch (err) {
        setMessage(message, err.message, 'error');
      }
    });
  });

  // ---------------------------------------------------------------------
  // チャット画面
  // ---------------------------------------------------------------------

  async function enterChat() {
    showView('view-chat');
    $('me-name').textContent = state.user.username;
    $('me-badge').hidden = !state.user.isAdmin;
    $('btn-admin').hidden = !state.user.isAdmin;
    clearNotice();
    try {
      const data = await api('/api/rooms');
      state.rooms = data.rooms;
    } catch (err) {
      showNotice(err.message);
      return;
    }
    renderRooms();
    if (state.rooms.length === 0) {
      $('room-title').textContent = '';
      return;
    }
    const keep = state.rooms.some((room) => room.id === state.roomId);
    await selectRoom(keep ? state.roomId : state.rooms[0].id);
  }

  function renderRooms() {
    const list = $('room-list');
    list.replaceChildren();
    for (const room of state.rooms) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'room-item' + (room.id === state.roomId ? ' active' : '');
      button.textContent = `# ${room.name}`;
      button.addEventListener('click', () => {
        closeSidebar();
        if (room.id !== state.roomId) selectRoom(room.id);
      });
      list.append(button);
    }
  }

  async function selectRoom(roomId) {
    const token = ++state.selectToken;
    closeWs();
    state.roomId = roomId;
    state.messages = [];
    state.knownIds = new Set();
    state.hasMore = false;
    renderRooms();
    const room = state.rooms.find((r) => r.id === roomId);
    $('room-title').textContent = room ? `# ${room.name}` : '';
    $('messages').replaceChildren();
    setStatus(false);

    try {
      const data = await api(`/api/rooms/${roomId}/messages?limit=50`);
      if (token !== state.selectToken) return;
      state.messages = data.messages;
      state.knownIds = new Set(data.messages.map((m) => m.id));
      state.hasMore = data.hasMore;
      renderAll();
      scrollToBottom();
      clearNotice();
    } catch (err) {
      if (token !== state.selectToken) return;
      showNotice(err.message);
    }
    if (token === state.selectToken) connectWs();
  }

  // ---------------------------------------------------------------------
  // メッセージの表示
  // ---------------------------------------------------------------------

  const timeFormat = new Intl.DateTimeFormat('ja-JP', { hour: '2-digit', minute: '2-digit' });
  const dateTimeFormat = new Intl.DateTimeFormat('ja-JP', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });

  function formatTime(ms) {
    const date = new Date(ms);
    const sameDay = date.toDateString() === new Date().toDateString();
    return (sameDay ? timeFormat : dateTimeFormat).format(date);
  }

  function nameColor(name) {
    let hash = 0;
    for (const ch of name) hash = (hash * 31 + ch.codePointAt(0)) >>> 0;
    return `hsl(${hash % 360}, 70%, 72%)`;
  }

  function createMessageElement(message, previous) {
    const grouped =
      previous && previous.user_id === message.user_id && message.created_at - previous.created_at < 5 * 60 * 1000;

    const element = document.createElement('div');
    element.className = 'msg' + (grouped ? ' grouped' : '');
    element.dataset.id = String(message.id);

    if (!grouped) {
      const head = document.createElement('div');
      head.className = 'msg-head';
      const name = document.createElement('span');
      name.className = 'msg-name';
      name.textContent = message.username;
      name.style.color = nameColor(message.username);
      const time = document.createElement('time');
      time.className = 'msg-time';
      time.dateTime = new Date(message.created_at).toISOString();
      time.textContent = formatTime(message.created_at);
      head.append(name, time);
      element.append(head);
    }

    const body = document.createElement('div');
    body.className = 'msg-body';
    body.textContent = message.content; // textContent なので、HTML は実行されません
    element.append(body);
    return element;
  }

  function buildTopNote() {
    const note = document.createElement('div');
    note.className = 'top-note';
    note.id = 'top-note';
    if (state.hasMore) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'btn small';
      button.textContent = '過去のメッセージを読み込む';
      button.addEventListener('click', loadOlder);
      note.append(button);
    } else if (state.messages.length === 0) {
      note.textContent = 'まだメッセージがありません。最初のひとことを送ってみましょう。';
    } else {
      note.textContent = 'ここが会話のはじまりです。';
    }
    return note;
  }

  function updateTopNote() {
    const old = $('top-note');
    if (old) old.replaceWith(buildTopNote());
  }

  function renderAll() {
    const container = $('messages');
    container.replaceChildren(buildTopNote());
    let previous = null;
    for (const message of state.messages) {
      container.append(createMessageElement(message, previous));
      previous = message;
    }
  }

  function isNearBottom() {
    const el = $('messages');
    return el.scrollHeight - el.scrollTop - el.clientHeight < 120;
  }

  function scrollToBottom() {
    const el = $('messages');
    el.scrollTop = el.scrollHeight;
  }

  function addMessage(message) {
    if (message.room_id !== state.roomId || state.knownIds.has(message.id)) return;
    const stickToBottom = isNearBottom() || message.user_id === state.user.id;
    const last = state.messages[state.messages.length - 1];
    state.knownIds.add(message.id);
    state.messages.push(message);

    if (!last || message.id > last.id) {
      $('messages').append(createMessageElement(message, last));
      if (state.messages.length === 1) updateTopNote();
    } else {
      state.messages.sort((a, b) => a.id - b.id);
      renderAll();
    }
    if (stickToBottom) scrollToBottom();
  }

  async function loadOlder() {
    if (state.loadingOlder || !state.hasMore || state.messages.length === 0) return;
    state.loadingOlder = true;
    const roomId = state.roomId;
    const firstId = state.messages[0].id;
    try {
      const data = await api(`/api/rooms/${roomId}/messages?before=${firstId}&limit=50`);
      if (roomId !== state.roomId) return;
      const el = $('messages');
      const previousHeight = el.scrollHeight;
      const previousTop = el.scrollTop;
      for (const message of data.messages) {
        if (!state.knownIds.has(message.id)) {
          state.knownIds.add(message.id);
          state.messages.push(message);
        }
      }
      state.messages.sort((a, b) => a.id - b.id);
      state.hasMore = data.hasMore;
      renderAll();
      el.scrollTop = el.scrollHeight - previousHeight + previousTop;
    } catch (err) {
      // 失敗したときは、もう一度スクロールするか、ボタンを押すと再試行されます
    } finally {
      state.loadingOlder = false;
    }
  }

  $('messages').addEventListener('scroll', () => {
    if ($('messages').scrollTop < 60) loadOlder();
  });

  // つながっていなかった間に届いたメッセージを取り戻します
  async function syncMissed() {
    const roomId = state.roomId;
    try {
      for (let i = 0; i < 5; i += 1) {
        const last = state.messages[state.messages.length - 1];
        const data = await api(`/api/rooms/${roomId}/messages?after=${last ? last.id : 0}`);
        if (roomId !== state.roomId) return;
        data.messages.forEach(addMessage);
        if (data.messages.length < 200) break;
      }
    } catch (err) {
      // 取得できなかったときは、次に再接続したときにもう一度試します
    }
  }

  // ---------------------------------------------------------------------
  // お知らせ・接続状態の表示
  // ---------------------------------------------------------------------

  function showNotice(text, kind, autoHideMs) {
    clearTimeout(state.noticeTimer);
    const notice = $('chat-notice');
    notice.textContent = text;
    notice.className = 'chat-notice' + (kind ? ` ${kind}` : '');
    notice.hidden = false;
    if (autoHideMs) state.noticeTimer = setTimeout(clearNotice, autoHideMs);
  }

  function clearNotice() {
    clearTimeout(state.noticeTimer);
    const notice = $('chat-notice');
    notice.hidden = true;
    notice.textContent = '';
  }

  function setStatus(connected) {
    const status = $('conn-status');
    status.textContent = connected ? '接続中' : '再接続中…';
    status.className = 'conn-status' + (connected ? ' ok' : '');
  }

  // ---------------------------------------------------------------------
  // リアルタイム通信（WebSocket）
  // ---------------------------------------------------------------------

  function closeWs() {
    clearTimeout(state.reconnectTimer);
    clearInterval(state.pingTimer);
    const ws = state.ws;
    state.ws = null;
    if (ws) {
      ws.onopen = null;
      ws.onmessage = null;
      ws.onclose = null;
      ws.onerror = null;
      try {
        ws.close();
      } catch (err) {
        // すでに閉じている場合は何もしません
      }
    }
  }

  function connectWs() {
    closeWs();
    if (!state.user || !state.roomId) return;
    setStatus(false);

    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    let ws;
    try {
      ws = new WebSocket(`${protocol}//${location.host}/ws?room=${state.roomId}`);
    } catch (err) {
      scheduleReconnect();
      return;
    }
    state.ws = ws;

    ws.onopen = () => {
      state.reconnectDelay = 1000;
      state.lastPong = Date.now();
      setStatus(true);
      state.pingTimer = setInterval(() => {
        if (state.ws !== ws) return;
        if (Date.now() - state.lastPong > 75000) {
          handleWsDown();
          return;
        }
        try {
          ws.send('ping');
        } catch (err) {
          // 送れないときは、上の確認でそのうち切断扱いになります
        }
      }, 25000);
      syncMissed();
    };

    ws.onmessage = (event) => {
      if (event.data === 'pong') {
        state.lastPong = Date.now();
        return;
      }
      try {
        const data = JSON.parse(event.data);
        if (data.type === 'message' && data.message) addMessage(data.message);
      } catch (err) {
        // 読み取れない通信は無視します
      }
    };

    ws.onclose = () => {
      if (state.ws === ws) handleWsDown();
    };
  }

  function handleWsDown() {
    closeWs();
    setStatus(false);
    scheduleReconnect();
  }

  function scheduleReconnect() {
    clearTimeout(state.reconnectTimer);
    state.reconnectTimer = setTimeout(async () => {
      // ログインが切れていないか確認してから、つなぎ直します
      try {
        await api('/api/me');
      } catch (err) {
        if (err.status === 401 || err.status === 403) return;
      }
      if (state.user && state.roomId) connectWs();
    }, state.reconnectDelay);
    state.reconnectDelay = Math.min(state.reconnectDelay * 2, 15000);
  }

  function reconnectNow() {
    if (!state.user || !state.roomId || state.user.mustChangePassword) return;
    state.reconnectDelay = 1000;
    connectWs();
  }

  // 他のアプリから戻ってきたとき、接続が生きているか確認します（iPad などで必要）
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    if (!state.user || !state.roomId || state.user.mustChangePassword) return;
    const ws = state.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      reconnectNow();
      return;
    }
    const sentAt = Date.now();
    try {
      ws.send('ping');
    } catch (err) {
      reconnectNow();
      return;
    }
    setTimeout(() => {
      if (state.ws === ws && state.lastPong < sentAt) reconnectNow();
    }, 4000);
  });

  window.addEventListener('online', reconnectNow);

  // ---------------------------------------------------------------------
  // メッセージの送信
  // ---------------------------------------------------------------------

  const input = $('input');
  const enterToSend = window.matchMedia('(any-pointer: fine)').matches;
  if (enterToSend) input.placeholder = 'メッセージを入力（Enterで送信、Shift+Enterで改行）';

  function autosize() {
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 140)}px`;
  }

  input.addEventListener('input', autosize);

  input.addEventListener('keydown', (event) => {
    // 日本語入力の変換中の Enter は送信しません
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && event.keyCode !== 229 && enterToSend) {
      event.preventDefault();
      $('composer').dispatchEvent(new Event('submit', { cancelable: true }));
    }
  });

  $('composer').addEventListener('submit', async (event) => {
    event.preventDefault();
    const content = input.value.trim();
    if (!content || !state.roomId || state.sending) return;

    state.sending = true;
    $('btn-send').disabled = true;
    input.value = '';
    autosize();
    try {
      const data = await api(`/api/rooms/${state.roomId}/messages`, { method: 'POST', body: { content } });
      addMessage(data.message);
      scrollToBottom();
      clearNotice();
    } catch (err) {
      if (input.value === '') {
        input.value = content;
        autosize();
      }
      showNotice(`送信できませんでした: ${err.message}`);
    } finally {
      state.sending = false;
      $('btn-send').disabled = false;
      input.focus();
    }
  });

  // ---------------------------------------------------------------------
  // スマホ・小さい画面でのメニュー
  // ---------------------------------------------------------------------

  function openSidebar() {
    $('sidebar').classList.add('open');
    $('sidebar-backdrop').hidden = false;
  }

  function closeSidebar() {
    $('sidebar').classList.remove('open');
    $('sidebar-backdrop').hidden = true;
  }

  $('btn-menu').addEventListener('click', openSidebar);
  $('sidebar-backdrop').addEventListener('click', closeSidebar);

  // ---------------------------------------------------------------------
  // ユーザー管理（管理者だけ）
  // ---------------------------------------------------------------------

  function showAdminResult(username, tempPassword) {
    const box = $('admin-result');
    box.replaceChildren();
    const text = document.createElement('div');
    text.textContent = `${username} さんの一時パスワードです。本人にだけ伝えてください（この画面を閉じると、もう一度は表示できません）。`;
    const code = document.createElement('code');
    code.textContent = tempPassword;
    box.append(text, code);
    box.hidden = false;
  }

  function hideAdminResult() {
    $('admin-result').hidden = true;
    $('admin-result').replaceChildren();
  }

  async function loadAdminUsers() {
    const list = $('admin-users');
    const error = $('admin-error');
    setMessage(error, '');
    try {
      const data = await api('/api/admin/users');
      list.replaceChildren();
      for (const user of data.users) list.append(createAdminRow(user));
    } catch (err) {
      setMessage(error, err.message, 'error');
    }
  }

  function createAdminRow(user) {
    const item = document.createElement('li');
    item.className = 'user-item';

    const label = document.createElement('div');
    const name = document.createElement('span');
    name.className = 'user-name';
    name.textContent = user.username;
    label.append(name);

    const tags = [];
    if (user.isAdmin) tags.push('管理者');
    if (user.id === state.user.id) tags.push('あなた');
    if (user.disabled) tags.push('停止中');
    if (user.mustChangePassword) tags.push('パスワード変更待ち');
    if (tags.length) {
      const tagElement = document.createElement('span');
      tagElement.className = 'user-tags';
      tagElement.textContent = tags.join('、');
      label.append(tagElement);
    }
    item.append(label);

    if (user.id !== state.user.id) {
      const actions = document.createElement('div');
      actions.className = 'user-actions';

      const reset = document.createElement('button');
      reset.type = 'button';
      reset.className = 'btn small';
      reset.textContent = 'パスワードをリセット';
      reset.addEventListener('click', () => adminResetPassword(user));

      const toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = user.disabled ? 'btn small' : 'btn small danger';
      toggle.textContent = user.disabled ? '停止を解除' : 'アカウントを停止';
      toggle.addEventListener('click', () => adminToggleDisabled(user));

      actions.append(reset, toggle);
      item.append(actions);
    }
    return item;
  }

  async function adminResetPassword(user) {
    if (!window.confirm(`${user.username} さんのパスワードをリセットして、一時パスワードを発行します。よろしいですか？`)) return;
    hideAdminResult();
    try {
      const data = await api(`/api/admin/users/${user.id}/reset-password`, { method: 'POST', body: {} });
      showAdminResult(data.username, data.tempPassword);
      await loadAdminUsers();
    } catch (err) {
      setMessage($('admin-error'), err.message, 'error');
    }
  }

  async function adminToggleDisabled(user) {
    const action = user.disabled ? '停止を解除' : '停止';
    if (!window.confirm(`${user.username} さんのアカウントを${action}します。よろしいですか？`)) return;
    try {
      await api(`/api/admin/users/${user.id}/disable`, { method: 'POST', body: { disabled: !user.disabled } });
      await loadAdminUsers();
    } catch (err) {
      setMessage($('admin-error'), err.message, 'error');
    }
  }

  $('btn-admin').addEventListener('click', () => {
    closeSidebar();
    hideAdminResult();
    $('admin-dialog').showModal();
    loadAdminUsers();
  });

  $('admin-close').addEventListener('click', () => $('admin-dialog').close());
  $('admin-dialog').addEventListener('close', hideAdminResult);

  // ---------------------------------------------------------------------
  // 起動
  // ---------------------------------------------------------------------

  async function init() {
    try {
      const data = await api('/api/me');
      await startSession(data.user);
    } catch (err) {
      showAuthTab('login');
      showView('view-auth');
      if (err.status === 0) setMessage($('login-message'), err.message, 'error');
    }
  }

  init();
})();
