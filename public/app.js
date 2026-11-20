/**
 * app.js – Toàn bộ logic frontend (Vanilla JS)
 *
 * Ý tưởng chính của "Persistent Player":
 *  - Ứng dụng là Single Page Application (SPA) dùng hash routing (#/album/1 ...).
 *  - Thẻ <audio> và thanh phát nhạc nằm NGOÀI vùng #view trong index.html.
 *  - Khi chuyển trang chỉ có #view được vẽ lại, nên nhạc không bao giờ bị ngắt.
 */
(() => {
  'use strict';

  /* ================================================================ */
  /* 1. TIỆN ÍCH                                                       */
  /* ================================================================ */

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

  const audio = $('#audio');
  const view = $('#view');

  const PLACEHOLDER =
    'data:image/svg+xml;utf8,' +
    encodeURIComponent(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" fill="#2a2a2a"/><path d="M46 28v26.5a9 9 0 1 0 5 8V38h12v-10H46z" fill="#777"/></svg>'
    );

  // Chống XSS: tên bài hát, nghệ sĩ... do người dùng nhập nên luôn escape trước khi chèn vào HTML
  const esc = (v) =>
    String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const fmtTime = (sec) => {
    if (!isFinite(sec) || sec <= 0) return '0:00';
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60).toString().padStart(2, '0');
    return `${m}:${s}`;
  };

  async function api(url, options) {
    const res = await fetch(url, options);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Yêu cầu ${url} thất bại (HTTP ${res.status})`);
    return data;
  }

  const jsonBody = (method, body) => ({
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  let toastTimer;
  function hideToast() {
    const el = $('#toast');
    if (!el) return;
    el.classList.add('hidden');
    el.setAttribute('aria-hidden', 'true');
    clearTimeout(toastTimer);
  }

  function toast(message) {
    const el = $('#toast');
    if (!el) return;
    $('#toast-message').textContent = message;
    el.classList.remove('hidden');
    el.setAttribute('aria-hidden', 'false');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(hideToast, 4800);
  }

  // Add event listeners for toast
  document.addEventListener('click', (e) => {
    const el = $('#toast');
    if (!el.classList.contains('hidden') && e.target === el) {
      hideToast();
    }
  });

  // We'll attach the close button listener inside the DOMContentLoaded or similar, 
  // but since this is an IIFE and everything is in one file, we can do it here 
  // after the elements are likely to be in the DOM.
  // However, in this SPA, elements are in index.html.
  // Let's use a safer way to attach it.
  const setupToastListeners = () => {
    const closeBtn = $('#toast-close');
    if (closeBtn) closeBtn.onclick = hideToast;
  };
  // Since it's a single page app and index.html is loaded once:
  setupToastListeners();


  function requireAccount() {
    if (state.user) return true;
    toast('Đăng nhập để sử dụng tính năng này');
    location.hash = '#/auth/login';
    return false;
  }

  function hasPremiumAccess(user = state.user) {
    if (!user || user.isPremium !== true) return false;
    return !user.premiumExpiresAt || Date.parse(user.premiumExpiresAt) > Date.now();
  }

  // Ảnh lỗi thì thay bằng ảnh mặc định
  document.addEventListener(
    'error',
    (e) => {
      const t = e.target;
      if (t.tagName === 'IMG' && !t.dataset.failed) {
        t.dataset.failed = '1';
        t.src = PLACEHOLDER;
      }
    },
    true
  );

  /* ================================================================ */
  /* 2. STATE                                                          */
  /* ================================================================ */

  const state = {
    songs: [],
    albums: [],
    artists: [],
    genres: [],
    playlists: [],
    favorites: new Set(),
    user: null,
    premiumRequests: [],
    paymentConfig: null,
    paymentConfigError: null,
    queue: [], // hàng đợi đang phát
    index: -1, // vị trí bài hiện tại trong queue
    history: [], // lịch sử vị trí khi bật shuffle (để nút Previous hoạt động)
    shuffle: false,
    repeat: 'off', // 'off' | 'all' | 'one'
    viewSongs: [], // danh sách bài của trang đang xem (để phát khi bấm vào hàng)
    songLists: new Map(),
    selectedPremiumPlan: 'month',
    viewCtx: {}, // ngữ cảnh trang hiện tại (vd: playlistId)
  };
  let accountStatusPolling = false;
  let accountStatusPollErrorShown = false;

  const currentSong = () => state.queue[state.index] || null;
  const supportState = {
    open: false,
    mode: 'bot',
    conversation: null,
    messages: [],
    lastMessageId: 0,
    loadedUserId: null,
    polling: false,
    pollErrorShown: false,
  };

  function appendSupportMessage(senderType, body, href = null) {
    supportState.messages.push({
      id: null,
      senderType,
      body,
      href,
      createdAt: new Date().toISOString(),
    });
    renderSupportMessages();
  }

  function renderSupportMessages() {
    const container = $('#support-messages');
    if (!container) return;
    container.replaceChildren();
    const messages = supportState.messages.length
      ? supportState.messages
      : [{ senderType: 'bot', body: 'Xin chào! Mình có thể giúp bạn nghe nhạc, tạo playlist hoặc tìm hiểu gói VIP.' }];
    messages.forEach((message) => {
      const row = document.createElement('div');
      row.className = `flex ${message.senderType === 'user' ? 'justify-end' : 'justify-start'}`;
      const bubble = document.createElement('div');
      bubble.className = `max-w-[85%] rounded-2xl px-3 py-2 text-sm ${
        message.senderType === 'user' ? 'bg-accent text-black' : 'bg-raised text-white'
      }`;
      const label = document.createElement('p');
      label.className = 'mb-1 text-[11px] font-bold opacity-70';
      label.textContent = message.senderType === 'user'
        ? 'Bạn'
        : message.senderType === 'admin'
          ? 'Chuyên viên'
          : 'Bot hỗ trợ';
      const content = document.createElement('p');
      content.className = 'whitespace-pre-wrap break-words';
      content.textContent = message.body;
      bubble.append(label, content);
      if (message.href) {
        const link = document.createElement('a');
        link.href = message.href;
        link.className = 'mt-2 inline-block font-bold underline';
        link.textContent = 'Đăng nhập';
        bubble.append(link);
      }
      row.append(bubble);
      container.append(row);
    });
    container.scrollTop = container.scrollHeight;
  }

  function renderSupportMode() {
    const status = $('#support-status');
    const connect = $('#support-connect');
    const input = $('#support-input');
    if (!status || !connect || !input) return;
    connect.classList.toggle(
      'hidden',
      supportState.mode === 'live' && supportState.conversation?.status !== 'closed'
    );
    if (supportState.mode === 'bot') {
      status.textContent = 'Bot hỗ trợ tự động';
      connect.textContent = 'Kết nối chuyên viên trực tuyến';
      connect.disabled = false;
      input.placeholder = 'Hỏi bot về nghe nhạc, VIP, playlist…';
      input.disabled = false;
    } else if (supportState.conversation?.status === 'waiting') {
      status.textContent = 'Đang chờ chuyên viên tiếp nhận';
      connect.textContent = 'Đang chờ chuyên viên…';
      connect.disabled = true;
      input.placeholder = 'Nhắn thêm thông tin cho chuyên viên…';
      input.disabled = false;
    } else if (supportState.conversation?.status === 'active') {
      status.textContent = 'Đang trò chuyện với chuyên viên';
      connect.textContent = 'Đã kết nối chuyên viên';
      connect.disabled = true;
      input.placeholder = 'Nhập tin nhắn cho chuyên viên…';
      input.disabled = false;
    } else {
      status.textContent = 'Cuộc trò chuyện đã kết thúc';
      connect.textContent = 'Kết nối chuyên viên mới';
      connect.disabled = false;
      input.placeholder = 'Kết nối lại để tiếp tục trò chuyện';
      input.disabled = true;
    }
  }

  function mergeSupportMessages(messages) {
    const seen = new Set(supportState.messages.filter((message) => message.id !== null).map((message) => message.id));
    messages.forEach((message) => {
      if (seen.has(message.id)) return;
      supportState.messages.push(message);
      seen.add(message.id);
      supportState.lastMessageId = Math.max(supportState.lastMessageId, message.id);
    });
    renderSupportMessages();
  }

  function resetSupportConversation() {
    supportState.mode = 'bot';
    supportState.conversation = null;
    supportState.messages = [];
    supportState.lastMessageId = 0;
    supportState.loadedUserId = null;
    renderSupportMode();
    renderSupportMessages();
  }

  async function loadCurrentSupportConversation() {
    if (!state.user) return;
    if (supportState.loadedUserId !== state.user.id) {
      supportState.mode = 'bot';
      supportState.conversation = null;
      supportState.messages = [];
      supportState.lastMessageId = 0;
      supportState.loadedUserId = state.user.id;
    }
    const result = await api('/api/support/conversations/current');
    supportState.conversation = result.conversation;
    if (result.conversation) {
      supportState.mode = 'live';
      supportState.messages = [];
      supportState.lastMessageId = 0;
      mergeSupportMessages(result.messages);
    }
    renderSupportMode();
    renderSupportMessages();
  }

  async function pollSupportMessages() {
    if (
      !supportState.open ||
      supportState.mode !== 'live' ||
      !supportState.conversation ||
      supportState.polling
    ) return;
    supportState.polling = true;
    try {
      const query = supportState.lastMessageId ? `?after=${supportState.lastMessageId}` : '';
      const result = await api(
        `/api/support/conversations/${supportState.conversation.id}/messages${query}`
      );
      supportState.conversation = result.conversation;
      mergeSupportMessages(result.messages);
      renderSupportMode();
      supportState.pollErrorShown = false;
    } catch (error) {
      if (!supportState.pollErrorShown) {
        appendSupportMessage('bot', `Không thể đồng bộ tin nhắn: ${error.message}`);
      }
      supportState.pollErrorShown = true;
    } finally {
      supportState.polling = false;
    }
  }

  function answerSupportBot(text) {
    const normalized = text.toLocaleLowerCase('vi')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '');
    if (/vip|premium|goi cuoc|nang cap|thanh toan/.test(normalized)) {
      return 'Bạn có thể xem các gói tại mục Gói VIP. Gửi yêu cầu nâng cấp; Admin duyệt thì VIP mới được kích hoạt. QR và thanh toán hiện chỉ là mô phỏng.';
    }
    if (/playlist|danh sach phat/.test(normalized)) {
      return 'Đăng nhập rồi bấm dấu + cạnh Playlist để tạo danh sách mới. Trong danh sách bài hát, dùng nút thêm vào playlist để lưu bài.';
    }
    if (/loi|khong phat|khong nghe|am thanh|phat nhac|stream/.test(normalized)) {
      return 'Thử tải lại trang, kiểm tra âm lượng và kết nối Internet. Nếu bài có nhãn VIP, tài khoản cần có gói VIP còn hạn. Bạn có thể kết nối chuyên viên nếu vẫn chưa nghe được.';
    }
    if (/tim kiem|nghe nhac|cach nghe/.test(normalized)) {
      return 'Chọn bài hát trên trang chủ hoặc tìm bằng ô tìm kiếm ở đầu trang, rồi nhấn nút phát. Thanh điều khiển nhạc nằm ở cuối màn hình.';
    }
    if (/dang nhap|tai khoan|mat khau/.test(normalized)) {
      return 'Dùng nút Đăng nhập ở góc trên để đăng nhập hoặc tạo tài khoản mới. Không gửi mật khẩu trong khung chat này nhé.';
    }
    if (/lien he|hotline|so dien thoai|email admin|lien lac|tro giup/.test(normalized)) {
      return 'Hãy bấm “Kết nối chuyên viên trực tuyến” để được hỗ trợ ngay trong ứng dụng.';
    }
    return 'Mình có thể hướng dẫn cách nghe nhạc, xử lý lỗi phát, tạo playlist và gói VIP. Nếu cần hỗ trợ trực tiếp, hãy bấm “Kết nối chuyên viên trực tuyến”.';
  }

  async function connectSupportAgent() {
    if (!state.user) {
      appendSupportMessage('bot', 'Để chuyên viên xem và trả lời tin nhắn, bạn cần đăng nhập trước.', '#/auth/login');
      return;
    }
    try {
      const result = await api('/api/support/conversations', { method: 'POST' });
      supportState.mode = 'live';
      supportState.conversation = result.conversation;
      supportState.messages = [];
      supportState.lastMessageId = 0;
      mergeSupportMessages(result.messages);
      renderSupportMode();
      if (result.conversation.status === 'waiting') {
        appendSupportMessage('bot', 'Đã gửi tín hiệu chờ chuyên viên tiếp nhận. Bạn có thể mô tả vấn đề trong lúc chờ.');
      }
      pollSupportMessages();
    } catch (error) {
      appendSupportMessage('bot', `Chưa thể kết nối chuyên viên: ${error.message}`);
    }
  }

  async function sendSupportMessage(text) {
    if (supportState.mode === 'bot') {
      appendSupportMessage('user', text);
      appendSupportMessage('bot', answerSupportBot(text));
      return;
    }
    if (!supportState.conversation || supportState.conversation.status === 'closed') return;
    const send = $('#support-send');
    send.disabled = true;
    try {
      const result = await api(
        `/api/support/conversations/${supportState.conversation.id}/messages`,
        jsonBody('POST', { message: text })
      );
      mergeSupportMessages([result]);
      pollSupportMessages();
    } catch (error) {
      appendSupportMessage('bot', `Tin nhắn chưa được gửi: ${error.message}`);
    } finally {
      send.disabled = false;
    }
  }

  function initSupportWidget() {
    const panel = $('#support-panel');
    const toggle = $('#support-toggle');
    const form = $('#support-form');
    const input = $('#support-input');
    let dragStart = null;
    let suppressNextToggle = false;

    toggle.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      const rect = toggle.getBoundingClientRect();
      dragStart = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, left: rect.left, top: rect.top, moved: false };
      toggle.setPointerCapture(event.pointerId);
    });
    toggle.addEventListener('pointermove', (event) => {
      if (!dragStart || event.pointerId !== dragStart.pointerId) return;
      const dx = event.clientX - dragStart.x;
      const dy = event.clientY - dragStart.y;
      if (!dragStart.moved && Math.hypot(dx, dy) < 6) return;
      dragStart.moved = true;
      const rect = toggle.getBoundingClientRect();
      const left = Math.max(0, Math.min(window.innerWidth - rect.width, dragStart.left + dx));
      const top = Math.max(0, Math.min(window.innerHeight - rect.height, dragStart.top + dy));
      toggle.style.left = `${left}px`;
      toggle.style.top = `${top}px`;
      toggle.style.right = 'auto';
      toggle.style.bottom = 'auto';
    });
    const finishDrag = (event) => {
      if (!dragStart || event.pointerId !== dragStart.pointerId) return;
      suppressNextToggle = dragStart.moved;
      dragStart = null;
    };
    toggle.addEventListener('pointerup', finishDrag);
    toggle.addEventListener('pointercancel', (event) => {
      if (dragStart && event.pointerId === dragStart.pointerId) {
        dragStart = null;
        suppressNextToggle = false;
      }
    });

    const close = () => {
      supportState.open = false;
      panel.classList.add('hidden');
      toggle.setAttribute('aria-expanded', 'false');
    };
    toggle.addEventListener('click', async () => {
      if (suppressNextToggle) {
        suppressNextToggle = false;
        return;
      }
      supportState.open = !supportState.open;
      panel.classList.toggle('hidden', !supportState.open);
      toggle.setAttribute('aria-expanded', String(supportState.open));
      if (supportState.open) {
        renderSupportMessages();
        if (state.user) {
          try {
            await loadCurrentSupportConversation();
          } catch (error) {
            appendSupportMessage('bot', `Không tải được hội thoại: ${error.message}`);
          }
        }
        renderSupportMode();
        pollSupportMessages();
        input.focus();
      }
    });
    $('#support-close').addEventListener('click', close);
    $('#support-connect').addEventListener('click', connectSupportAgent);
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const text = input.value.trim();
      if (!text) return;
      input.value = '';
      await sendSupportMessage(text);
      input.focus();
    });
    window.setInterval(pollSupportMessages, 1800);
    appendSupportMessage(
      'bot',
      'Xin chào! Mình có thể giúp bạn nghe nhạc, tạo playlist, xử lý lỗi phát hoặc tìm hiểu gói VIP.'
    );
    renderSupportMode();
  }

  async function loadAll() {
    const [coreData, paymentResult] = await Promise.all([
      Promise.all([
        api('/api/songs'),
        api('/api/albums'),
        api('/api/artists'),
        api('/api/genres'),
        api('/api/playlists'),
        api('/api/auth/me'),
      ]),
      api('/api/payments/vnpay/config').then(
        (paymentConfig) => ({ paymentConfig, error: null }),
        (error) => ({ paymentConfig: null, error })
      ),
    ]);
    const [songs, albums, artists, genres, playlists, auth] = coreData;
    const [favorites, premiumRequests] = auth.user
      ? await Promise.all([api('/api/favorites'), api('/api/premium/requests')])
      : [[], []];
    Object.assign(state, {
      songs, albums, artists, genres, playlists, user: auth.user,
      favorites: new Set(favorites.map((song) => song.id)),
      premiumRequests,
      paymentConfig: paymentResult.paymentConfig,
      paymentConfigError: paymentResult.error?.message || null,
    });
    renderAccountArea();
  }

  async function refreshPlaylists() {
    state.playlists = await api('/api/playlists');
    renderSidebar();
  }

  async function pollAccountStatus() {
    if (accountStatusPolling || document.hidden || !state.user) return;
    accountStatusPolling = true;
    try {
      const [auth, premiumRequests] = await Promise.all([
        api('/api/auth/me'),
        api('/api/premium/requests'),
      ]);
      if (!auth.user) {
        state.user = null;
        state.favorites = new Set();
        state.premiumRequests = [];
        resetSupportConversation();
        await refreshPlaylists();
        renderAccountArea();
        if (location.hash.startsWith('#/premium')) viewPremium();
        toast('Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.');
        accountStatusPollErrorShown = false;
        return;
      }

      const previousUser = state.user;
      const previousRequests = new Map(state.premiumRequests.map((request) => [request.id, request.status]));
      const accountChanged = JSON.stringify(previousUser) !== JSON.stringify(auth.user);
      const requestsChanged = JSON.stringify(state.premiumRequests) !== JSON.stringify(premiumRequests);
      state.user = auth.user;
      state.premiumRequests = premiumRequests;
      const vipJustActivated = !hasPremiumAccess(previousUser) && hasPremiumAccess(auth.user);
      const vipAccessChanged = hasPremiumAccess(previousUser) !== hasPremiumAccess(auth.user);
      const changedRequest = premiumRequests.find((request) =>
        previousRequests.has(request.id) &&
        previousRequests.get(request.id) !== request.status &&
        (request.status === 'approved' || request.status === 'rejected')
      );
      if (accountChanged) renderAccountArea();
      updateSupportHotlineDisplay();
      if (vipJustActivated && changedRequest?.payment?.status === 'paid') {
        toast('VNPay xác nhận thành công. VIP đã được kích hoạt!');
      } else if (vipJustActivated) {
        toast('Yêu cầu đã được duyệt. VIP đã kích hoạt!');
      } else if (changedRequest) {
        toast(changedRequest.payment?.status === 'paid'
          ? 'VNPay xác nhận thành công. Gói VIP đã được gia hạn.'
          : changedRequest.payment?.status === 'failed'
            ? 'Giao dịch VNPay thất bại. Bạn có thể thử thanh toán lại.'
            : changedRequest.status === 'approved'
              ? 'Yêu cầu VIP đã được Admin duyệt.'
              : 'Yêu cầu VIP đã bị từ chối.');
      }
      if (vipAccessChanged || changedRequest || requestsChanged) {
        if (location.hash.startsWith('#/premium/payment/')) await route();
        else if (location.hash.startsWith('#/premium')) viewPremium();
        else if (location.hash.startsWith('#/vip')) await route();
      }
      accountStatusPollErrorShown = false;
    } catch (error) {
      if (!accountStatusPollErrorShown) toast(`Không thể cập nhật trạng thái tài khoản: ${error.message}`);
      accountStatusPollErrorShown = true;
    } finally {
      accountStatusPolling = false;
    }
  }

  /* ================================================================ */
  /* 3. TRÌNH PHÁT NHẠC (PERSISTENT PLAYER)                            */
  /* ================================================================ */

  const el = {
    cover: $('#np-cover'),
    empty: $('#np-empty'),
    title: $('#np-title'),
    artist: $('#np-artist'),
    add: $('#np-add'),
    play: $('#btn-play'),
    icPlay: $('#ic-play'),
    icPause: $('#ic-pause'),
    prev: $('#btn-prev'),
    next: $('#btn-next'),
    shuffle: $('#btn-shuffle'),
    repeat: $('#btn-repeat'),
    repeatOne: $('#repeat-one'),
    progress: $('#progress'),
    cur: $('#time-cur'),
    dur: $('#time-dur'),
    volume: $('#volume'),
    mute: $('#btn-mute'),
    icVol: $('#ic-vol'),
    icMute: $('#ic-mute'),
  };
  const visualizerCanvas = $('#audio-visualizer');
  const visualizerContext = visualizerCanvas?.getContext('2d') || null;
  let audioContext = null;
  let analyser = null;
  let visualizerFrame = 0;
  let visualizerUnavailable = false;
  let activeLyricLine = -1;

  function prepareVisualizer() {
    if (!visualizerContext || visualizerUnavailable) return;
    let mediaSource = null;
    try {
      if (!audioContext) {
        const AudioContextClass = window.AudioContext || window.webkitAudioContext;
        if (!AudioContextClass) throw new Error('Trình duyệt không hỗ trợ Web Audio API');
        audioContext = new AudioContextClass();
        analyser = audioContext.createAnalyser();
        analyser.fftSize = 128;
        mediaSource = audioContext.createMediaElementSource(audio);
        mediaSource.connect(analyser);
        analyser.connect(audioContext.destination);
      }
      if (audioContext.state === 'suspended') {
        audioContext.resume().catch((error) => {
          console.error('Không thể bật audio visualizer:', error);
        });
      }
    } catch (error) {
      visualizerUnavailable = true;
      console.error('Không thể khởi tạo audio visualizer:', error);
      if (mediaSource && audioContext) {
        try {
          mediaSource.connect(audioContext.destination);
        } catch (fallbackError) {
          console.error('Không thể khôi phục đầu ra âm thanh:', fallbackError);
        }
      }
    }
  }

  function drawVisualizer() {
    if (!analyser || !visualizerContext || audio.paused || audio.ended) {
      visualizerFrame = 0;
      if (visualizerContext && visualizerCanvas) {
        visualizerContext.clearRect(0, 0, visualizerCanvas.width, visualizerCanvas.height);
      }
      return;
    }
    const bounds = visualizerCanvas.getBoundingClientRect();
    const ratio = window.devicePixelRatio || 1;
    const width = Math.max(1, Math.floor(bounds.width * ratio));
    const height = Math.max(1, Math.floor(bounds.height * ratio));
    if (visualizerCanvas.width !== width || visualizerCanvas.height !== height) {
      visualizerCanvas.width = width;
      visualizerCanvas.height = height;
    }
    const context = visualizerContext;
    context.clearRect(0, 0, width, height);
    const values = new Uint8Array(analyser.frequencyBinCount);
    analyser.getByteFrequencyData(values);
    const bars = 48;
    const gap = Math.max(1, ratio);
    const barWidth = Math.max(1, (width - gap * (bars - 1)) / bars);
    const gradient = context.createLinearGradient(0, 0, width, 0);
    gradient.addColorStop(0, '#73fca7');
    gradient.addColorStop(0.5, '#1ed760');
    gradient.addColorStop(1, '#a4ffd0');
    context.fillStyle = gradient;
    for (let index = 0; index < bars; index += 1) {
      const value = values[Math.floor(index * values.length / bars)] / 255;
      const barHeight = Math.max(ratio, value * height);
      context.fillRect(index * (barWidth + gap), (height - barHeight) / 2, barWidth, barHeight);
    }
    visualizerFrame = window.requestAnimationFrame(drawVisualizer);
  }

  function startVisualizer() {
    prepareVisualizer();
    if (analyser && !visualizerFrame) visualizerFrame = window.requestAnimationFrame(drawVisualizer);
  }

  // Tô màu phần đã chạy của thanh trượt
  function setFill(range) {
    const pct = ((range.value - range.min) / (range.max - range.min)) * 100;
    range.style.setProperty('--fill', `${pct}%`);
  }

  // Phát danh sách `songs`, bắt đầu từ vị trí `startIndex`
  function playList(songs, startIndex = 0) {
    if (!songs.length) return;
    const firstSong = songs[startIndex];
    if (firstSong && firstSong.isVip && !hasPremiumAccess()) {
      showVipRequired(firstSong);
      return;
    }
    state.queue = songs.slice();
    state.history = [];
    playIndex(startIndex);
  }

  function playIndex(i) {
    const song = state.queue[i];
    if (!song) return;
    if (song.isVip && !hasPremiumAccess()) {
      showVipRequired(song);
      return;
    }
    state.index = i;
    audio.src = song.streamUrl; // trình duyệt tự gửi Range request tới /api/stream/:id
    activeLyricLine = -1;
    if (location.hash.startsWith('#/lyrics')) renderLyrics();
    prepareVisualizer();
    savePlayerState(0);
    audio.play().catch(() => {
      /* bị chặn autoplay hoặc lỗi nguồn – sự kiện 'error' sẽ xử lý */
    });
    updateNowPlaying(song);
    // Ghi nhận lượt nghe (không cần chờ kết quả)
    fetch(`/api/songs/${song.id}/play`, { method: 'POST' }).catch(() => {});
  }

  function togglePlay() {
    if (!currentSong()) {
      playList(state.songs, 0); // chưa chọn bài nào → phát từ đầu thư viện
      return;
    }
    if (currentSong().isVip && !hasPremiumAccess()) {
      showVipRequired(currentSong());
      return;
    }
    if (audio.paused) {
      prepareVisualizer();
      audio.play().catch(() => {});
    }
    else audio.pause();
  }

  function nextSong(auto = false) {
    const n = state.queue.length;
    if (!n) return;

    if (auto && state.repeat === 'one') {
      audio.currentTime = 0;
      audio.play().catch(() => {});
      return;
    }
    if (state.shuffle && n > 1) {
      let i;
      do {
        i = Math.floor(Math.random() * n);
      } while (i === state.index);
      state.history.push(state.index);
      return playIndex(i);
    }
    let i = state.index + 1;
    if (i >= n) {
      if (auto && state.repeat === 'off') {
        // Hết danh sách và không lặp → dừng, đưa về đầu bài cuối
        audio.pause();
        audio.currentTime = 0;
        return;
      }
      i = 0;
    }
    playIndex(i);
  }

  function prevSong() {
    if (!state.queue.length) return;
    // Nghe quá 3 giây thì quay về đầu bài hiện tại, giống Spotify
    if (audio.currentTime > 3) {
      audio.currentTime = 0;
      return;
    }
    if (state.shuffle && state.history.length) return playIndex(state.history.pop());
    let i = state.index - 1;
    if (i < 0) i = state.repeat === 'all' ? state.queue.length - 1 : 0;
    playIndex(i);
  }

  function updateNowPlaying(song) {
    el.cover.src = song.cover || PLACEHOLDER;
    el.cover.dataset.failed = '';
    el.cover.classList.remove('hidden');
    el.empty.classList.add('hidden');
    el.title.textContent = song.title;
    el.artist.textContent = song.artistName;
    el.artist.href = `#/artist/${song.artistId}`;
    el.add.classList.remove('hidden');
    document.title = `${song.title} – ${song.artistName}`;
    if (location.hash.startsWith('#/lyrics')) renderLyrics();
    markPlaying();

    if ('mediaSession' in navigator) {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: song.title,
        artist: song.artistName,
        album: song.albumTitle || '',
        artwork: song.cover ? [{ src: song.cover, sizes: '400x400' }] : [],
      });
    }
  }

  function savePlayerState(position = audio.currentTime) {
    const song = currentSong();
    if (!song) return;
    try {
      localStorage.setItem('music-player-state', JSON.stringify({
        queueIds: state.queue.map((item) => item.id),
        currentSongId: song.id,
        currentTime: Number.isFinite(position) ? position : 0,
        shuffle: state.shuffle,
        repeat: state.repeat,
      }));
    } catch {
      /* bỏ qua nếu trình duyệt chặn localStorage */
    }
  }

  let pendingRestoreTime = null;
  function restorePlayerState() {
    try {
      const saved = JSON.parse(localStorage.getItem('music-player-state') || 'null');
      if (!saved || !Array.isArray(saved.queueIds)) return;
      state.queue = saved.queueIds
        .map((id) => state.songs.find((song) => song.id === Number(id)))
        .filter(Boolean);
      state.index = state.queue.findIndex((song) => song.id === Number(saved.currentSongId));
      if (state.index < 0) {
        state.queue = [];
        return;
      }
      state.shuffle = saved.shuffle === true;
      state.repeat = ['off', 'all', 'one'].includes(saved.repeat) ? saved.repeat : 'off';
      pendingRestoreTime = Number.isFinite(saved.currentTime) && saved.currentTime > 0
        ? saved.currentTime
        : null;
      const song = currentSong();
      audio.src = song.streamUrl;
      updateNowPlaying(song);
      el.shuffle.classList.toggle('on', state.shuffle);
      el.repeat.classList.toggle('on', state.repeat !== 'off');
      el.repeatOne.classList.toggle('hidden', state.repeat !== 'one');
    } catch {
      /* bỏ qua nếu trạng thái lưu bị hỏng hoặc trình duyệt chặn localStorage */
    }
  }

  // Đánh dấu hàng đang phát trong bảng bài hát + cập nhật icon play/pause
  function markPlaying() {
    const song = currentSong();
    $$('.song-row').forEach((row) =>
      row.classList.toggle('playing', !!song && Number(row.dataset.id) === song.id)
    );
    document.body.classList.toggle('paused', audio.paused);
    el.icPlay.classList.toggle('hidden', !audio.paused);
    el.icPause.classList.toggle('hidden', audio.paused);
  }

  // --- Sự kiện của thẻ <audio> ---
  audio.addEventListener('play', markPlaying);
  audio.addEventListener('play', startVisualizer);
  audio.addEventListener('play', savePlayerState);
  audio.addEventListener('pause', () => {
    if (visualizerFrame) {
      window.cancelAnimationFrame(visualizerFrame);
      visualizerFrame = 0;
    }
    if (visualizerContext && visualizerCanvas) {
      visualizerContext.clearRect(0, 0, visualizerCanvas.width, visualizerCanvas.height);
    }
    markPlaying();
    savePlayerState();
  });
  audio.addEventListener('ended', () => nextSong(true));
  audio.addEventListener('error', () => {
    if (audio.getAttribute('src')) toast('Không phát được bài này. Thử bài khác nhé.');
    markPlaying();
  });
  audio.addEventListener('loadedmetadata', () => {
    el.dur.textContent = fmtTime(audio.duration);
    if (pendingRestoreTime !== null) {
      audio.currentTime = Math.min(pendingRestoreTime, Math.max(0, audio.duration - 1));
      pendingRestoreTime = null;
      savePlayerState();
    }
  });

  let seeking = false; // đang kéo thanh tiến trình thì không cập nhật tự động
  audio.addEventListener('timeupdate', () => {
    el.cur.textContent = fmtTime(audio.currentTime);
    if (Date.now() - lastPlayerSave >= 5000) {
      lastPlayerSave = Date.now();
      savePlayerState();
    }
    if (seeking || !isFinite(audio.duration) || audio.duration <= 0) return;
    el.progress.value = (audio.currentTime / audio.duration) * 1000;
    setFill(el.progress);
    if (location.hash.startsWith('#/lyrics')) updateSyncedLyrics(audio.currentTime);
  });
  let lastPlayerSave = 0;
  window.addEventListener('pagehide', savePlayerState);

  // --- Thanh tiến trình: kéo để tua ---
  el.progress.addEventListener('input', () => {
    seeking = true;
    setFill(el.progress);
    if (isFinite(audio.duration)) el.cur.textContent = fmtTime((el.progress.value / 1000) * audio.duration);
  });
  el.progress.addEventListener('change', () => {
    if (isFinite(audio.duration)) audio.currentTime = (el.progress.value / 1000) * audio.duration;
    seeking = false;
  });

  // --- Âm lượng ---
  function applyVolume() {
    audio.volume = el.volume.value / 100;
    audio.muted = audio.volume === 0 ? true : audio.muted;
    setFill(el.volume);
    const muted = audio.muted || audio.volume === 0;
    el.icVol.classList.toggle('hidden', muted);
    el.icMute.classList.toggle('hidden', !muted);
    try {
      localStorage.setItem('music-volume', el.volume.value);
    } catch {
      /* bỏ qua nếu trình duyệt chặn localStorage */
    }
  }
  el.volume.addEventListener('input', () => {
    if (audio.muted && el.volume.value > 0) audio.muted = false;
    applyVolume();
  });
  el.mute.addEventListener('click', () => {
    audio.muted = !audio.muted;
    if (!audio.muted && el.volume.value === '0') el.volume.value = 50;
    applyVolume();
  });

  // --- Các nút điều khiển ---
  el.play.addEventListener('click', togglePlay);
  el.next.addEventListener('click', () => nextSong(false));
  el.prev.addEventListener('click', prevSong);
  el.shuffle.addEventListener('click', () => {
    state.shuffle = !state.shuffle;
    state.history = [];
    el.shuffle.classList.toggle('on', state.shuffle);
    toast(state.shuffle ? 'Đã bật phát ngẫu nhiên' : 'Đã tắt phát ngẫu nhiên');
  });
  el.repeat.addEventListener('click', () => {
    state.repeat = { off: 'all', all: 'one', one: 'off' }[state.repeat];
    el.repeat.classList.toggle('on', state.repeat !== 'off');
    el.repeatOne.classList.toggle('hidden', state.repeat !== 'one');
    toast({ off: 'Tắt lặp lại', all: 'Lặp lại danh sách', one: 'Lặp lại một bài' }[state.repeat]);
  });
  el.add.addEventListener('click', () => {
    const song = currentSong();
    if (song) openAddToPlaylist(song.id);
  });

  // --- Phím tắt: Space = phát/dừng ---
  document.addEventListener('keydown', (e) => {
    if (e.code !== 'Space' || e.ctrlKey || e.metaKey || e.altKey) return;
    const t = e.target;
    const typing =
      t.tagName === 'TEXTAREA' ||
      t.tagName === 'SELECT' ||
      t.tagName === 'BUTTON' ||
      (t.tagName === 'INPUT' && t.type !== 'range');
    if (typing) return;
    e.preventDefault();
    togglePlay();
  });

  // --- Điều khiển từ bàn phím media / màn hình khóa ---
  if ('mediaSession' in navigator) {
    const ms = navigator.mediaSession;
    ms.setActionHandler('play', togglePlay);
    ms.setActionHandler('pause', () => audio.pause());
    ms.setActionHandler('previoustrack', prevSong);
    ms.setActionHandler('nexttrack', () => nextSong(false));
  }

  /* ================================================================ */
  /* 4. MODAL                                                          */
  /* ================================================================ */

  const modalRoot = $('#modal-root');

  function closeModal() {
    modalRoot.innerHTML = '';
  }

  function showVipRequired(song) {
    modalRoot.innerHTML = `
      <div class="fixed inset-0 z-40 grid place-items-center bg-black/75 p-4" data-overlay>
        <section role="dialog" aria-modal="true" aria-labelledby="vip-required-title" class="w-full max-w-md rounded-2xl border border-amber-300/30 bg-raised p-6 shadow-2xl">
          <div class="mb-4 inline-flex rounded-full bg-amber-300 px-3 py-1 text-xs font-extrabold tracking-widest text-black">VIP</div>
          <h2 id="vip-required-title" class="text-2xl font-extrabold">Bài hát này dành riêng cho tài khoản VIP</h2>
          <p class="mt-2 text-muted">${esc(song.title)} — ${esc(song.artistName)}. Nâng cấp để nghe bài hát này và toàn bộ nội dung VIP.</p>
          <div class="mt-6 flex flex-wrap justify-end gap-2">
            <button data-action="close-modal" class="rounded-full border border-line px-4 py-2 font-semibold hover:bg-panel">Để sau</button>
            <button data-action="open-premium" class="rounded-full bg-amber-300 px-5 py-2 font-bold text-black">Xem gói VIP</button>
          </div>
          ${state.user ? '' : '<p class="mt-4 text-right text-sm text-muted">Bạn cần <a class="underline text-white" href="#/auth/login">đăng nhập</a> trước khi nâng cấp.</p>'}
        </section>
      </div>`;
  }

  // Hộp thoại nhập một dòng văn bản; trả về Promise<string|null>
  function promptModal({ title, label, value = '', submit = 'Lưu' }) {
    return new Promise((resolve) => {
      modalRoot.innerHTML = `
        <div class="fixed inset-0 z-40 bg-black/70 grid place-items-center p-4" data-overlay>
          <div role="dialog" aria-modal="true" aria-label="${esc(title)}" class="bg-raised rounded-xl w-full max-w-sm p-6">
            <h3 class="text-xl font-bold mb-4">${esc(title)}</h3>
            <label class="block text-sm text-muted mb-1" for="modal-input">${esc(label)}</label>
            <input id="modal-input" class="field" value="${esc(value)}" maxlength="60" autocomplete="off" />
            <div class="flex justify-end gap-2 mt-5">
              <button data-cancel class="px-4 py-2 rounded-full font-semibold text-muted hover:text-white">Hủy</button>
              <button data-ok class="px-5 py-2 rounded-full bg-accent text-black font-bold">${esc(submit)}</button>
            </div>
          </div>
        </div>`;
      const input = $('#modal-input');
      input.focus();
      input.select();

      const done = (v) => {
        document.removeEventListener('keydown', onKey);
        closeModal();
        resolve(v);
      };
      const onKey = (e) => {
        if (e.key === 'Escape') done(null);
        if (e.key === 'Enter' && document.activeElement === input) done(input.value.trim() || null);
      };
      document.addEventListener('keydown', onKey);
      $('[data-ok]', modalRoot).onclick = () => done(input.value.trim() || null);
      $('[data-cancel]', modalRoot).onclick = () => done(null);
      $('[data-overlay]', modalRoot).onclick = (e) => {
        if (e.target === e.currentTarget) done(null);
      };
    });
  }

  function confirmModal({ title = 'Xác nhận thao tác', message, confirm = 'Xác nhận', danger = false }) {
    return new Promise((resolve) => {
      modalRoot.innerHTML = `
        <div class="fixed inset-0 z-40 grid place-items-center bg-black/75 p-4" data-confirm-overlay>
          <section role="alertdialog" aria-modal="true" aria-labelledby="confirm-modal-title" class="w-full max-w-md rounded-2xl border border-line bg-raised p-6 shadow-2xl">
            <span class="center-notice-icon">${danger ? '!' : '?'}</span>
            <h2 id="confirm-modal-title" class="mt-4 text-xl font-bold">${esc(title)}</h2>
            <p class="mt-2 text-sm leading-6 text-muted">${esc(message)}</p>
            <div class="mt-6 flex justify-end gap-3">
              <button type="button" data-confirm-cancel class="rounded-full border border-line px-5 py-2 font-semibold hover:bg-panel">Hủy</button>
              <button type="button" data-confirm-accept class="rounded-full ${danger ? 'bg-red-400 text-black' : 'bg-accent text-black'} px-5 py-2 font-bold hover:brightness-110">${esc(confirm)}</button>
            </div>
          </section>
        </div>`;

      const finish = (accepted) => {
        document.removeEventListener('keydown', onKey);
        closeModal();
        resolve(accepted);
      };
      const onKey = (event) => {
        if (event.key === 'Escape') finish(false);
      };
      document.addEventListener('keydown', onKey);
      $('[data-confirm-cancel]', modalRoot).addEventListener('click', () => finish(false));
      $('[data-confirm-accept]', modalRoot).addEventListener('click', () => finish(true));
      $('[data-confirm-overlay]', modalRoot).addEventListener('click', (event) => {
        if (event.target === event.currentTarget) finish(false);
      });
      $('[data-confirm-cancel]', modalRoot).focus();
    });
  }

  // Hộp thoại chọn playlist để thêm bài hát
  function openAddToPlaylist(songId) {
    if (!requireAccount()) return;
    const song = state.songs.find((s) => s.id === songId);
    const items = state.playlists
      .filter((playlist) => playlist.canEdit)
      .map(
        (p) => `
        <button data-pick="${p.id}" class="pl-item">
          <span class="w-10 h-10 rounded bg-line grid place-items-center text-muted shrink-0">${plIcon()}</span>
          <span class="min-w-0"><span class="block font-semibold truncate">${esc(p.name)}</span>
          <span class="block text-sm text-muted">${p.songs.length} bài hát</span></span>
        </button>`
      )
      .join('');

    modalRoot.innerHTML = `
      <div class="fixed inset-0 z-40 bg-black/70 grid place-items-center p-4" data-overlay>
        <div role="dialog" aria-modal="true" aria-label="Thêm vào playlist" class="bg-raised rounded-xl w-full max-w-sm p-6 max-h-[80vh] flex flex-col">
          <h3 class="text-xl font-bold">Thêm vào playlist</h3>
          <p class="text-sm text-muted mb-4 truncate">${esc(song ? song.title : '')}</p>
          <div class="overflow-y-auto scroll-thin flex-1 -mx-2 px-2">
            ${items || '<p class="text-muted text-sm py-4">Bạn chưa có playlist nào.</p>'}
          </div>
          <div class="flex justify-between gap-2 mt-4">
            <button data-new class="px-4 py-2 rounded-full border border-line font-semibold hover:bg-line">Tạo playlist mới</button>
            <button data-cancel class="px-4 py-2 rounded-full font-semibold text-muted hover:text-white">Đóng</button>
          </div>
        </div>
      </div>`;

    const onKey = (e) => e.key === 'Escape' && close();
    const close = () => {
      document.removeEventListener('keydown', onKey);
      closeModal();
    };
    document.addEventListener('keydown', onKey);

    $('[data-overlay]', modalRoot).onclick = (e) => e.target === e.currentTarget && close();
    $('[data-cancel]', modalRoot).onclick = close;

    $$('[data-pick]', modalRoot).forEach((btn) =>
      btn.addEventListener('click', async () => {
        close();
        await addSongToPlaylist(Number(btn.dataset.pick), songId);
      })
    );
    $('[data-new]', modalRoot).onclick = async () => {
      close();
      const name = await promptModal({ title: 'Tạo playlist mới', label: 'Tên playlist', submit: 'Tạo' });
      if (!name) return;
      try {
        const pl = await api('/api/playlists', jsonBody('POST', { name }));
        await addSongToPlaylist(pl.id, songId);
      } catch (err) {
        toast(err.message);
      }
    };
  }

  /* ================================================================ */
  /* 5. PLAYLIST ACTIONS                                               */
  /* ================================================================ */

  const plIcon = () =>
    '<svg class="w-5 h-5" viewBox="0 0 24 24" fill="currentColor"><path d="M3 6h14v2H3zm0 4h14v2H3zm0 4h9v2H3zm14 0v-2h2v2h2v2h-2v2h-2v-2h-2v-2z"/></svg>';

  async function addSongToPlaylist(playlistId, songId) {
    try {
      const pl = await api(`/api/playlists/${playlistId}/songs`, jsonBody('POST', { songId }));
      await refreshPlaylists();
      toast(`Đã thêm vào "${pl.name}"`);
      if (state.viewCtx.playlistId === playlistId) route();
    } catch (err) {
      toast(err.message);
    }
  }

  async function createPlaylist() {
    if (!requireAccount()) return;
    const name = await promptModal({ title: 'Tạo playlist mới', label: 'Tên playlist', submit: 'Tạo' });
    if (!name) return;
    try {
      const pl = await api('/api/playlists', jsonBody('POST', { name }));
      await refreshPlaylists();
      location.hash = `#/playlist/${pl.id}`;
    } catch (err) {
      toast(err.message);
    }
  }

  async function renamePlaylist(id) {
    const pl = state.playlists.find((p) => p.id === id);
    const name = await promptModal({ title: 'Đổi tên playlist', label: 'Tên mới', value: pl ? pl.name : '' });
    if (!name) return;
    try {
      await api(`/api/playlists/${id}`, jsonBody('PUT', { name }));
      await refreshPlaylists();
      route();
    } catch (err) {
      toast(err.message);
    }
  }

  async function deletePlaylist(id) {
    const pl = state.playlists.find((p) => p.id === id);
    if (!await confirmModal({
      title: 'Xóa playlist?',
      message: `Bạn có chắc muốn xóa playlist "${pl ? pl.name : ''}" không?`,
      confirm: 'Xóa playlist',
      danger: true,
    })) return;
    try {
      await api(`/api/playlists/${id}`, { method: 'DELETE' });
      await refreshPlaylists();
      toast('Đã xóa playlist');
      location.hash = '#/';
    } catch (err) {
      toast(err.message);
    }
  }

  async function removeFromPlaylist(playlistId, songId) {
    try {
      await api(`/api/playlists/${playlistId}/songs/${songId}`, { method: 'DELETE' });
      await refreshPlaylists();
      route();
    } catch (err) {
      toast(err.message);
    }
  }

  /* ================================================================ */
  /* 6. RENDER: SIDEBAR + THÀNH PHẦN DÙNG CHUNG                        */
  /* ================================================================ */

  function renderSidebar(activeId) {
    const [page, arg] = parseHash();
    const active = activeId ?? (page === 'playlist' ? Number(arg) : null);
    $('#playlist-list').innerHTML = state.playlists.length
      ? state.playlists
          .map(
            (p) => `
          <li><a href="#/playlist/${p.id}" class="pl-item ${p.id === active ? 'active' : ''}">
            <span class="w-12 h-12 rounded bg-raised grid place-items-center text-muted shrink-0">${plIcon()}</span>
            <span class="min-w-0"><span class="block font-semibold truncate">${esc(p.name)}</span>
            <span class="block text-sm text-muted">${p.songs.length} bài hát</span></span>
          </a></li>`
          )
          .join('')
      : `<li class="px-3 py-4 text-sm text-muted">${state.user ? 'Chưa có playlist. Bấm dấu + để tạo playlist đầu tiên.' : 'Đăng nhập để tạo playlist của riêng bạn.'}</li>`;
  }

  function renderAccountArea() {
    const area = $('#account-area');
    if (!area) return;
    area.innerHTML = state.user
      ? `<div class="flex items-center gap-2 flex-wrap">${state.user.role === 'admin' ? '<a href="/admin.html" class="px-4 py-2 rounded-full bg-accent text-black text-sm font-bold">Quản trị</a>' : ''}<a href="#/premium" class="rounded-full ${hasPremiumAccess() ? 'bg-amber-300 text-black' : 'border border-amber-300 text-amber-200'} px-3 py-2 text-xs font-extrabold">${hasPremiumAccess() ? 'PRO' : 'Nâng cấp VIP'}</a><a href="#/account/profile" class="rounded-full border border-line px-2 py-2 text-xs font-semibold hover:bg-raised sm:px-3"><span class="sm:hidden">Thông tin</span><span class="hidden sm:inline">Thông tin bảo mật</span></a><a href="#/account/password" class="rounded-full border border-line px-2 py-2 text-xs font-semibold hover:bg-raised sm:px-3"><span class="sm:hidden">Mật khẩu</span><span class="hidden sm:inline">Đổi mật khẩu</span></a><span class="hidden max-w-32 truncate text-sm text-muted sm:block">${esc(state.user.name)}${state.user.phone ? ' · ' + esc(state.user.phone) : ''}${hasPremiumAccess() ? ' · VIP' : ''}</span><button id="btn-logout" class="rounded-full border border-line px-4 py-2 text-sm font-semibold hover:bg-raised">Đăng xuất</button></div>`
      : '<a href="#/auth/login" class="inline-block px-4 py-2 rounded-full bg-white text-black text-sm font-bold hover:scale-105 transition-transform">Đăng nhập</a>';
  }

  const sectionTitle = (text) => `<h2 class="text-2xl font-bold mt-8 mb-3">${esc(text)}</h2>`;

  const playButton = (action = 'play-all') => `
    <button data-action="${action}" title="Phát" class="w-14 h-14 rounded-full bg-accent text-black grid place-items-center hover:scale-105 transition-transform">
      <svg class="w-6 h-6 ml-0.5" viewBox="0 0 24 24" fill="currentColor"><path d="M7 4v16l13-8z"/></svg>
    </button>`;

  const gridClass = 'grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-2';

  const albumCard = (a) => `
    <a href="#/album/${a.id}" class="card">
      <img src="${esc(a.cover)}" alt="" loading="lazy" class="aspect-square w-full object-cover rounded-md mb-3 shadow-lg" />
      <p class="font-semibold truncate">${esc(a.title)}</p>
      <p class="text-sm text-muted truncate">${esc(a.artistName)}</p>
    </a>`;

  const artistCard = (a) => `
    <a href="#/artist/${a.id}" class="card">
      <img src="${esc(a.avatar)}" alt="" loading="lazy" class="aspect-square w-full object-cover rounded-full mb-3 shadow-lg" />
      <p class="font-semibold truncate">${esc(a.name)}</p>
      <p class="text-sm text-muted">Nghệ sĩ</p>
    </a>`;

  // Bảng danh sách bài hát. Lưu danh sách vào state.viewSongs để bấm vào hàng là phát được.
  function songTable(songs, { removable = false, listKey = 'main' } = {}) {
    state.songLists.set(listKey, songs);
    if (listKey === 'main') state.viewSongs = songs;
    if (!songs.length) return '';
    const cur = currentSong();
    const rows = songs
      .map(
        (s, i) => `
      <div class="song-row ${cur && cur.id === s.id ? 'playing' : ''}" data-action="play-row" data-list="${esc(listKey)}" data-index="${i}" data-id="${s.id}">
        <div class="grid place-items-center text-muted">
          <span class="row-index tabular-nums">${i + 1}</span>
          <span class="eq"><i></i><i></i><i></i></span>
        </div>
        <div class="flex items-center gap-3 min-w-0">
          <img src="${esc(s.cover)}" alt="" loading="lazy" class="w-10 h-10 rounded object-cover shrink-0" />
          <div class="min-w-0">
            <p class="song-title flex items-center gap-2 font-semibold truncate">${esc(s.title)}${s.isVip ? '<span class="shrink-0 rounded-full bg-amber-300 px-2 py-0.5 text-[10px] font-extrabold tracking-wider text-black">VIP</span>' : ''}</p>
            <a href="#/artist/${s.artistId}" class="text-sm text-muted truncate block hover:underline hover:text-white">${esc(s.artistName)}</a>
          </div>
        </div>
        <div class="hidden md:block text-sm text-muted truncate">
          ${s.albumId ? `<a href="#/album/${s.albumId}" class="hover:underline hover:text-white">${esc(s.albumTitle)}</a>` : esc(s.genre || '')}
        </div>
        <div class="flex items-center justify-end gap-1">
          <button data-action="toggle-favorite" data-id="${s.id}" title="${state.favorites.has(s.id) ? 'Bỏ yêu thích' : 'Thêm vào yêu thích'}"
            aria-label="${state.favorites.has(s.id) ? 'Bỏ yêu thích' : 'Thêm vào yêu thích'}"
            class="row-btn ctl ${state.favorites.has(s.id) ? 'text-accent' : ''}">
            <svg class="w-5 h-5" viewBox="0 0 24 24" fill="${state.favorites.has(s.id) ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2.2"><path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8l1.1 1.1L12 21l7.8-7.5 1.1-1.1a5.5 5.5 0 0 0-.1-7.8z"/></svg>
          </button>
          <button data-action="add-to-playlist" data-id="${s.id}" title="Thêm vào playlist" class="row-btn ctl">
            <svg class="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><circle cx="12" cy="12" r="9"/><path d="M12 8v8M8 12h8"/></svg>
          </button>
          ${
            removable
              ? `<button data-action="remove-from-playlist" data-id="${s.id}" title="Bỏ khỏi playlist" class="row-btn ctl">
                   <svg class="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M6 6l12 12M18 6 6 18"/></svg>
                 </button>`
              : ''
          }
          <span class="text-sm text-muted w-12 text-right tabular-nums">${s.duration ? fmtTime(s.duration) : '–'}</span>
        </div>
      </div>`
      )
      .join('');
    return `<div class="mt-2">${rows}</div>`;
  }

  const emptyState = (title, hint) => `
    <div class="py-16 text-center">
      <p class="text-xl font-bold">${esc(title)}</p>
      <p class="text-muted mt-1">${hint}</p>
    </div>`;

  /* ================================================================ */
  /* 7. RENDER: CÁC TRANG                                              */
  /* ================================================================ */

  function viewHome() {
    state.viewCtx = {};
    const h = new Date().getHours();
    const greet = h < 11 ? 'Chào buổi sáng' : h < 18 ? 'Chào buổi chiều' : 'Chào buổi tối';
    const newestSongs = state.songs.slice().sort((a, b) => b.id - a.id).slice(0, 5);
    const topSongs = state.songs.slice()
      .sort((a, b) => (b.plays || 0) - (a.plays || 0) || b.id - a.id)
      .slice(0, 5);
    const topSongIds = new Set(topSongs.map((song) => song.id));
    const trendingSongs = [
      ...topSongs,
      ...state.songs
        .filter((song) => song.isTrending && !topSongIds.has(song.id))
        .sort((a, b) => (b.plays || 0) - (a.plays || 0) || b.id - a.id),
    ];
    view.innerHTML = `
      <h1 class="text-3xl font-extrabold pt-2">${greet}</h1>
      ${sectionTitle('Bài hát mới')}
      ${newestSongs.length ? songTable(newestSongs, { listKey: 'newest' }) : emptyState('Chưa có bài hát', '')}
      ${sectionTitle('Đang thịnh hành')}
      <p class="mb-3 text-sm text-muted">Top 5 theo lượt nghe cùng các bài do Admin đề cử.</p>
      ${trendingSongs.length ? songTable(trendingSongs, { listKey: 'trending' }) : emptyState('Chưa có bài thịnh hành', '')}
      ${sectionTitle('Album')}
      <div class="${gridClass}">${state.albums.map(albumCard).join('')}</div>
      ${sectionTitle('Nghệ sĩ')}
      <div class="${gridClass}">${state.artists.map(artistCard).join('')}</div>
      <div class="flex items-center gap-4 mt-8 mb-1">
        ${playButton()}
        <h2 class="text-2xl font-bold">Tất cả bài hát</h2>
      </div>
      ${state.songs.length ? songTable(state.songs) : emptyState('Chưa có bài hát nào', 'Hãy <a class="underline" href="#/upload">tải bài hát đầu tiên</a> lên.')}`;
  }

  function viewFavorites() {
    state.viewCtx = {};
    const songs = state.songs.filter((song) => state.favorites.has(song.id));
    view.innerHTML = `
      <h1 class="text-3xl font-extrabold pt-2">Bài hát yêu thích</h1>
      <p class="mt-2 text-sm text-muted">${songs.length} bài hát</p>
      ${songs.length
        ? songTable(songs)
        : emptyState('Chưa có bài hát yêu thích', state.user
          ? 'Nhấn biểu tượng trái tim ở một bài hát để lưu vào đây.'
          : 'Đăng nhập để lưu bài hát yêu thích của bạn.')}`;
  }

  async function viewVipLibrary() {
    state.viewCtx = {};
    state.viewSongs = [];
    if (!hasPremiumAccess()) {
      view.innerHTML = `
        <section class="mx-auto max-w-3xl py-12 text-center">
          <span class="inline-flex rounded-full bg-amber-300 px-3 py-1 text-xs font-extrabold tracking-widest text-black">KHO NHẠC VIP</span>
          <h1 class="mt-4 text-3xl font-extrabold">Nội dung dành riêng cho thành viên VIP</h1>
          <p class="mx-auto mt-3 max-w-xl text-muted">${state.user
            ? 'Gói VIP của bạn chưa hoạt động hoặc đã hết hạn. Chọn gói phù hợp để mở khóa kho nhạc VIP.'
            : 'Đăng nhập bằng tài khoản đang có gói VIP để truy cập kho nhạc và các đặc quyền.'}</p>
          <div class="mt-6 flex flex-wrap justify-center gap-3">
            ${state.user
              ? ''
              : '<a href="#/auth/login" class="rounded-full bg-white px-5 py-3 font-bold text-black">Đăng nhập</a>'}
            <a href="#/premium" class="rounded-full bg-amber-300 px-5 py-3 font-bold text-black">Xem các gói VIP</a>
          </div>
        </section>`;
      return;
    }

    const songs = await api('/api/premium/songs');
    state.viewSongs = songs;
    view.innerHTML = `
      <section class="pt-4">
        <div class="rounded-2xl border border-amber-300/30 bg-gradient-to-br from-amber-300/10 to-transparent p-5 sm:p-8">
          <span class="inline-flex rounded-full bg-amber-300 px-3 py-1 text-xs font-extrabold tracking-widest text-black">THÀNH VIÊN PRO</span>
          <h1 class="mt-3 text-3xl font-extrabold sm:text-4xl">Kho nhạc VIP</h1>
          <p class="mt-2 text-muted">Toàn bộ bài hát dành riêng cho tài khoản có gói VIP còn hạn.</p>
          <div class="mt-5 grid gap-3 sm:grid-cols-2">
            <p class="rounded-xl border border-line bg-panel/70 p-4 font-semibold">Nghe các bài hát được đánh dấu VIP</p>
            <p class="rounded-xl border border-line bg-panel/70 p-4 font-semibold">Truy cập kho nhạc VIP riêng</p>
          </div>
          <div class="mt-5 flex items-center gap-4">
            ${songs.length ? playButton() : ''}
            <p class="text-sm text-muted">${songs.length} bài hát VIP</p>
          </div>
        </div>
        ${songs.length
          ? songTable(songs, { listKey: 'vip-library' })
          : emptyState('Chưa có bài hát VIP', 'Các bài hát được Admin đánh dấu VIP sẽ xuất hiện tại đây.')}
      </section>`;
  }

  const premiumPlans = {
    month: { name: 'Gói Tháng', months: 1, price: 49000, note: 'Linh hoạt, thanh toán mô phỏng' },
    halfYear: { name: 'Gói 6 Tháng', months: 6, price: 269000, note: 'Tiết kiệm hơn gói tháng' },
    year: { name: 'Gói Năm', months: 12, price: 499000, note: 'Tốt nhất cho người nghe thường xuyên' },
  };

  let lyricsSongId = null;

  function parseLyrics(lyrics) {
    const entries = [];
    String(lyrics || '').split(/\r?\n/).forEach((line) => {
      const timestamps = [...line.matchAll(/\[(\d{1,2}):(\d{2})(?:[.:](\d{1,3}))?\]/g)];
      const text = line.replace(/\[\d{1,2}:\d{2}(?:[.:]\d{1,3})?\]/g, '').trim();
      if (timestamps.length) {
        timestamps.forEach((match) => {
          const fraction = match[3] || '';
          const seconds = Number(match[1]) * 60 + Number(match[2]) +
            (fraction ? Number(`0.${fraction}`) : 0);
          entries.push({ time: seconds, text });
        });
      } else if (text) {
        entries.push({ time: null, text });
      }
    });
    return entries.sort((a, b) => {
      if (a.time === null) return 1;
      if (b.time === null) return -1;
      return a.time - b.time;
    });
  }

  function renderLyrics() {
    const song = currentSong();
    if (!song) {
      view.innerHTML = emptyState('Chưa có bài hát đang phát', 'Phát một bài hát rồi mở Lời bài hát để xem lời.');
      lyricsSongId = null;
      activeLyricLine = -1;
      return;
    }
    if (lyricsSongId !== song.id) activeLyricLine = -1;
    lyricsSongId = song.id;
    const entries = parseLyrics(song.lyrics);
    view.innerHTML = `
      <section class="mx-auto max-w-3xl py-8">
        <header class="mb-8 flex items-center gap-4">
          <img src="${esc(song.cover || PLACEHOLDER)}" alt="" class="h-20 w-20 rounded-xl object-cover shadow-lg" />
          <div class="min-w-0">
            <p class="text-sm font-semibold uppercase tracking-widest text-accent">Lời bài hát</p>
            <h1 class="truncate text-2xl font-extrabold">${esc(song.title)}</h1>
            <p class="truncate text-muted">${esc(song.artistName)}</p>
          </div>
        </header>
        ${entries.length
          ? `<div id="lyrics-lines" class="space-y-5 py-[30vh] text-center" aria-live="polite">${entries.map((entry, index) => `
            <p data-lyric-line="${index}" class="lyric-line ${entry.time === null ? 'text-base font-normal' : ''}">${esc(entry.text)}</p>
          `).join('')}</div>
          ${entries.some((entry) => entry.time !== null)
            ? '<p class="text-center text-xs text-muted">Để đồng bộ chính xác, lời cần có mốc thời gian LRC, ví dụ [00:12.50]Lời bài hát.</p>'
            : '<p class="text-center text-sm text-muted">Lời này chưa có mốc thời gian nên không thể chạy đồng bộ.</p>'}`
          : '<div class="rounded-2xl border border-line bg-panel p-6 text-center text-muted">Chưa có lời bài hát. Admin có thể thêm lời dạng LRC với mốc thời gian trong phần sửa bài hát.</div>'}
      </section>`;
    updateSyncedLyrics(audio.currentTime);
  }

  function updateSyncedLyrics(currentTime) {
    const song = currentSong();
    if (!song || !location.hash.startsWith('#/lyrics')) return;
    const lines = parseLyrics(song.lyrics);
    let currentIndex = -1;
    lines.forEach((line, index) => {
      if (line.time !== null && line.time <= currentTime) currentIndex = index;
    });
    if (currentIndex === activeLyricLine) return;
    activeLyricLine = currentIndex;
    const nodes = $$('#lyrics-lines [data-lyric-line]');
    nodes.forEach((node, index) => node.classList.toggle('active', index === currentIndex));
    if (currentIndex >= 0) {
      nodes[currentIndex]?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }

  function mockQrCode() {
    return `<svg viewBox="0 0 21 21" class="h-40 w-40 rounded-lg bg-white p-3" role="img" aria-label="Mã QR minh họa, không dùng để thanh toán">
      <rect width="21" height="21" fill="white"/>
      <path fill="#111" d="M1 1h7v7H1zM2 2v5h5V2zM3 3h3v3H3zM13 1h7v7h-7zM14 2v5h5V2zM15 3h3v3h-3zM1 13h7v7H1zM2 14v5h5v-5zM3 15h3v3H3z"/>
      <path fill="#111" d="M10 1h2v2h-2zM9 4h2v2H9zM11 7h2v2h-2zM9 9h3v2H9zM13 9h2v2h-2zM17 9h2v2h-2zM8 11h2v2H8zM11 12h2v2h-2zM14 12h2v2h-2zM18 12h2v2h-2zM9 14h2v2H9zM12 15h2v2h-2zM15 15h2v2h-2zM18 16h2v2h-2zM9 18h2v2H9zM12 18h2v2h-2zM15 19h2v1h-2z"/>
    </svg>`;
  }

  function viewPremium() {
    state.viewCtx = {};
    const pendingRequest = state.premiumRequests.find((request) => request.status === 'pending');
    if (pendingRequest) state.selectedPremiumPlan = pendingRequest.plan;
    const selected = premiumPlans[state.selectedPremiumPlan] || premiumPlans.month;
    const vnpayEnabled = state.paymentConfig?.enabled === true;
    const paymentConfigUnavailable = Boolean(state.paymentConfigError);
    view.innerHTML = `
      <section class="mx-auto max-w-5xl pt-4">
        <div class="text-center">
          <span class="inline-flex rounded-full bg-amber-300 px-3 py-1 text-xs font-extrabold tracking-widest text-black">NHẠC ONLINE PRO</span>
          <h1 class="mt-4 text-4xl font-extrabold sm:text-5xl">Nghe nhạc VIP không giới hạn</h1>
          <p class="mx-auto mt-3 max-w-2xl text-muted">Mở khóa các bài hát VIP và tiếp tục ủng hộ trải nghiệm nghe nhạc của bạn.</p>
          ${hasPremiumAccess()
            ? `<p class="mt-3 font-semibold text-amber-200">Tài khoản đang là VIP${state.user.premiumExpiresAt ? ` đến ${esc(new Date(state.user.premiumExpiresAt).toLocaleDateString('vi-VN'))}` : ''}.</p>`
            : ''}
          ${pendingRequest
            ? `<p class="mt-3 rounded-lg border border-amber-300/40 bg-amber-300/10 p-3 text-amber-100">${pendingRequest.payment?.status === 'pending' ? 'Giao dịch VNPay đang chờ xác nhận.' : 'Yêu cầu đang chờ Admin duyệt.'} Tài khoản chưa được nâng cấp.</p>`
            : ''}
        </div>
        <div class="mt-8 grid gap-4 md:grid-cols-3">
          ${Object.entries(premiumPlans).map(([key, plan]) => `
            <button data-action="select-premium-plan" data-plan="${key}" class="rounded-2xl border ${state.selectedPremiumPlan === key ? 'border-amber-300 bg-amber-300/10' : 'border-line bg-panel'} p-5 text-left transition hover:border-amber-300">
              <span class="text-lg font-bold">${esc(plan.name)}</span>
              <span class="mt-3 block text-3xl font-extrabold">${plan.price.toLocaleString('vi-VN')}đ</span>
              <span class="mt-2 block text-sm text-muted">${plan.months} tháng · ${esc(plan.note)}</span>
            </button>`).join('')}
        </div>
        <div class="mt-6 grid gap-6 rounded-2xl border border-line bg-panel p-5 md:grid-cols-[1fr_auto] md:items-center md:p-8">
          <div>
            <h2 class="text-2xl font-bold">${paymentConfigUnavailable
              ? 'Phương thức thanh toán tạm thời không khả dụng'
              : vnpayEnabled ? `VNPay Sandbox · ${esc(selected.name)}` : `Thanh toán mô phỏng · ${esc(selected.name)}`}</h2>
            <p class="mt-2 text-muted">${paymentConfigUnavailable
              ? `Không thể xác minh cấu hình thanh toán: ${esc(state.paymentConfigError)}. Vui lòng tải lại trang hoặc liên hệ Admin.`
              : vnpayEnabled
              ? 'Bạn sẽ được chuyển sang môi trường thử nghiệm VNPay. Không dùng thẻ thật; VIP chỉ kích hoạt sau khi máy chủ xác minh IPN.'
              : 'Mã QR minh họa MoMo/VietQR — không chứa thông tin thanh toán và không thể quét chuyển tiền.'}</p>
            ${paymentConfigUnavailable ? '' : `<p class="mt-3 text-sm text-muted">${vnpayEnabled
              ? 'Sandbox không thu tiền thật. Đơn hàng, mã tham chiếu và kết quả VNPay sẽ được lưu trong hệ thống để Admin đối soát.'
              : 'Đây là quy trình demo: không có giao dịch tiền thật. Sau khi gửi yêu cầu, Admin cần duyệt thì VIP mới được kích hoạt.'}</p>`}
            ${pendingRequest
              ? `<div class="mt-5 flex flex-wrap items-center gap-3">
                  <button class="cursor-not-allowed rounded-full bg-raised px-6 py-3 font-bold text-muted" disabled>${pendingRequest.payment?.status === 'pending' ? 'Đang chờ VNPay xác nhận' : 'Đang chờ Admin duyệt'}</button>
                  ${pendingRequest.payment?.status === 'pending'
                    ? `<button type="button" data-action="refresh-premium-payment" data-txn-ref="${esc(pendingRequest.payment.txnRef)}" class="rounded-full border border-line px-5 py-3 font-semibold hover:bg-raised">Kiểm tra giao dịch</button>`
                    : ''}
                </div>`
              : state.user
              ? paymentConfigUnavailable
                ? '<button class="mt-5 cursor-not-allowed rounded-full bg-raised px-6 py-3 font-bold text-muted" disabled>Chưa thể xác minh thanh toán</button>'
                : `<button data-action="${vnpayEnabled ? 'checkout-premium' : 'upgrade-premium'}" class="mt-5 rounded-full bg-amber-300 px-6 py-3 font-extrabold text-black hover:brightness-110">${vnpayEnabled ? 'Thanh toán thử qua VNPay' : 'Gửi yêu cầu nâng cấp'}</button>`
              : '<a href="#/auth/login" class="mt-5 inline-block rounded-full bg-amber-300 px-6 py-3 font-extrabold text-black">Đăng nhập để nâng cấp</a>'}
            <p id="premium-message" class="mt-3 text-sm text-muted" role="status"></p>
          </div>
          ${vnpayEnabled ? `
            <div class="grid justify-items-center gap-2 rounded-xl border border-amber-300/30 p-5 text-center text-sm">
              <span class="rounded-full bg-amber-300 px-3 py-1 font-extrabold text-black">VNPAY SANDBOX</span>
              <span class="text-muted">Thanh toán được xử lý trên trang VNPay thử nghiệm.</span>
              <span class="text-xs text-muted">Không nhập thông tin thẻ thật.</span>
            </div>` : paymentConfigUnavailable ? `
            <div class="grid justify-items-center gap-2 rounded-xl border border-red-400/30 p-5 text-center text-sm text-red-200" role="alert">
              <span>Chưa xác minh được trạng thái cổng thanh toán.</span>
              <span class="text-xs">Không gửi yêu cầu thanh toán lúc này.</span>
            </div>` : `
            <div class="grid justify-items-center gap-2 rounded-xl bg-white p-3 text-center text-xs font-semibold text-gray-600">
              ${mockQrCode()}
              <span>QR DEMO — KHÔNG THANH TOÁN</span>
            </div>`}
        </div>
        ${state.premiumRequests.length ? `
          <section class="mt-8">
            <h2 class="text-xl font-bold">Lịch sử yêu cầu VIP</h2>
            <div class="mt-3 overflow-x-auto rounded-xl border border-line">
              <table class="w-full min-w-[520px] text-left text-sm">
                <thead class="text-muted"><tr><th class="p-3">Gói</th><th class="p-3">Ngày gửi</th><th class="p-3">Trạng thái</th></tr></thead>
                <tbody>${state.premiumRequests.map((request) => `
                  <tr class="border-t border-line">
                    <td class="p-3">${esc(premiumPlans[request.plan]?.name || request.plan)} · ${Number(request.price).toLocaleString('vi-VN')}đ</td>
                    <td class="p-3">${esc(new Date(request.createdAt).toLocaleString('vi-VN'))}</td>
                    <td class="p-3">${request.payment
                      ? `${request.payment.status === 'pending' ? 'Chờ VNPay' : request.payment.status === 'expired' ? 'Đơn hết hạn, chưa hoàn tất' : request.payment.status === 'paid' ? 'Đã thanh toán Sandbox' : 'Thanh toán thất bại'} · ${esc(request.payment.txnRef)}`
                      : request.status === 'pending' ? 'Chờ duyệt' : request.status === 'approved' ? 'Đã duyệt' : 'Từ chối'}</td>
                  </tr>`).join('')}</tbody>
              </table>
            </div>
          </section>` : ''}
      </section>`;
  }

  async function viewPremiumPayment(txnRef) {
    if (!requireAccount()) return;
    state.viewCtx = {};
    view.innerHTML = '<p class="py-16 text-center text-muted">Đang kiểm tra giao dịch VNPay…</p>';
    let queryError = '';
    try {
      await api(`/api/premium/payments/${encodeURIComponent(txnRef)}/check`, { method: 'POST' });
    } catch (error) {
      queryError = error.message;
    }
    let payment = await api(`/api/premium/payments/${encodeURIComponent(txnRef)}`);
    const expectedHash = `#/premium/payment/${encodeURIComponent(txnRef)}`;
    for (let attempt = 0; payment.status === 'pending' && attempt < 6; attempt += 1) {
      await new Promise((resolve) => window.setTimeout(resolve, 2000));
      if (location.hash !== expectedHash) return;
      payment = await api(`/api/premium/payments/${encodeURIComponent(txnRef)}`);
    }

    if (payment.status === 'paid' && payment.vipActivated) {
      const [auth, premiumRequests] = await Promise.all([
        api('/api/auth/me'),
        api('/api/premium/requests'),
      ]);
      state.user = auth.user;
      state.premiumRequests = premiumRequests;
      renderAccountArea();
    }

    const statusLabels = {
      pending: 'Đang chờ IPN xác nhận',
      expired: 'Đơn đã hết hạn — chưa nhận được xác nhận thanh toán',
      paid: payment.vipActivated ? 'Đã thanh toán và kích hoạt VIP' : 'Đã thanh toán — cần Admin đối soát quyền VIP',
      failed: 'Giao dịch thất bại',
    };
    const amount = Number(payment.amount).toLocaleString('vi-VN');
    view.innerHTML = `
      <section class="mx-auto max-w-3xl py-10">
        <div class="rounded-2xl border border-line bg-panel p-6 sm:p-8">
          <p class="text-sm font-bold uppercase tracking-widest text-accent">VNPay Sandbox</p>
          <h1 class="mt-2 text-2xl font-extrabold">${esc(statusLabels[payment.status] || payment.status)}</h1>
          <p class="mt-2 text-muted">Đây là giao dịch thử nghiệm, không phát sinh thanh toán tiền thật.</p>
          ${queryError ? `<p role="alert" class="mt-3 text-sm text-red-400">${esc(queryError)}</p>` : ''}
          <dl class="mt-6 grid gap-3 text-sm sm:grid-cols-2">
            <div><dt class="text-muted">Mã đơn hàng (vnp_TxnRef)</dt><dd class="break-words font-semibold">${esc(payment.txnRef)}</dd></div>
            <div><dt class="text-muted">Gói</dt><dd class="font-semibold">${esc(premiumPlans[payment.plan]?.name || payment.plan)}</dd></div>
            <div><dt class="text-muted">Số tiền</dt><dd class="font-semibold">${amount} ${esc(payment.currency)}</dd></div>
            <div><dt class="text-muted">Mã giao dịch VNPay</dt><dd class="break-words font-semibold">${esc(payment.transactionNo || 'Chưa có')}</dd></div>
            <div><dt class="text-muted">Ngân hàng / loại thẻ</dt><dd class="font-semibold">${esc([payment.bankCode, payment.cardType].filter(Boolean).join(' / ') || 'Chưa có')}</dd></div>
            <div><dt class="text-muted">Mã phản hồi</dt><dd class="font-semibold">${esc(payment.responseCode || 'Đang chờ')}</dd></div>
            <div><dt class="text-muted">Tạo lúc</dt><dd class="font-semibold">${esc(new Date(payment.createdAt).toLocaleString('vi-VN'))}</dd></div>
            <div><dt class="text-muted">VNPay báo lúc</dt><dd class="font-semibold">${esc(payment.callbackAt ? new Date(payment.callbackAt).toLocaleString('vi-VN') : 'Đang chờ')}</dd></div>
          </dl>
          <div class="mt-6 flex flex-wrap gap-3">
            ${payment.status === 'pending' || payment.status === 'expired'
              ? `<button type="button" data-action="refresh-premium-payment" data-txn-ref="${esc(payment.txnRef)}" class="rounded-full bg-accent px-5 py-2 font-bold text-black">Kiểm tra lại trạng thái</button>`
              : ''}
            <a href="#/premium" class="rounded-full border border-line px-5 py-2 font-semibold hover:bg-raised">Quay lại gói VIP</a>
          </div>
        </div>
      </section>`;
  }

  async function checkoutPremium() {
    if (!requireAccount()) return;
    const message = $('#premium-message');
    try {
      const result = await api('/api/premium/checkout', jsonBody('POST', { plan: state.selectedPremiumPlan }));
      window.location.assign(result.paymentUrl);
    } catch (error) {
      if (message) message.textContent = error.message;
      else toast(error.message);
    }
  }

  async function upgradePremium() {
    if (!requireAccount()) return;
    const message = $('#premium-message');
    try {
      const result = await api('/api/premium/requests', jsonBody('POST', { plan: state.selectedPremiumPlan }));
      state.premiumRequests.unshift(result);
      toast('Đã gửi yêu cầu. VIP sẽ được kích hoạt sau khi Admin duyệt.');
      viewPremium();
    } catch (error) {
      if (message) message.textContent = error.message;
      else toast(error.message);
    }
  }

  async function toggleFavorite(songId) {
    if (!requireAccount()) return;
    const isFavorite = state.favorites.has(songId);
    await api(`/api/favorites/${songId}`, isFavorite
      ? { method: 'DELETE' }
      : { method: 'POST' });
    if (isFavorite) state.favorites.delete(songId);
    else state.favorites.add(songId);
    toast(isFavorite ? 'Đã bỏ khỏi yêu thích' : 'Đã thêm vào yêu thích');
    await route();
  }

  async function viewAlbum(id) {
    state.viewCtx = {};
    const album = await api(`/api/albums/${id}`);
    view.innerHTML = `
      <div class="flex flex-col sm:flex-row sm:items-end gap-5 pt-2">
        <img src="${esc(album.cover)}" alt="" class="w-44 h-44 md:w-56 md:h-56 rounded-lg object-cover shadow-2xl" />
        <div class="min-w-0">
          <h1 class="text-4xl md:text-6xl font-extrabold line-2">${esc(album.title)}</h1>
          <p class="mt-3 text-muted">
            <a href="#/artist/${album.artistId}" class="font-semibold text-white hover:underline">${esc(album.artistName)}</a>
            ${album.year ? ` – ${album.year}` : ''} – ${album.songs.length} bài hát
          </p>
        </div>
      </div>
      <div class="mt-6">${playButton()}</div>
      ${album.songs.length ? songTable(album.songs) : emptyState('Album chưa có bài hát', 'Nghệ sĩ sẽ sớm cập nhật.')}`;
  }

  async function viewArtist(id) {
    state.viewCtx = {};
    const artist = await api(`/api/artists/${id}`);
    view.innerHTML = `
      <div class="flex flex-col sm:flex-row sm:items-end gap-5 pt-2">
        <img src="${esc(artist.avatar)}" alt="" class="w-44 h-44 md:w-56 md:h-56 rounded-full object-cover shadow-2xl" />
        <div class="min-w-0">
          <h1 class="text-4xl md:text-6xl font-extrabold line-2">${esc(artist.name)}</h1>
          <p class="mt-3 text-muted max-w-xl">${esc(artist.bio || 'Chưa có giới thiệu.')}</p>
        </div>
      </div>
      <div class="mt-6">${playButton()}</div>
      ${sectionTitle('Bài hát')}
      ${artist.songs.length ? songTable(artist.songs) : emptyState('Chưa có bài hát', '')}
      ${artist.albums.length ? sectionTitle('Album') + `<div class="${gridClass}">${artist.albums.map(albumCard).join('')}</div>` : ''}`;
  }

  async function viewSearch(query) {
    state.viewCtx = {};
    const q = (query || '').trim();
    const input = $('#search-input');
    if (document.activeElement !== input) input.value = q;

    if (!q) {
      // Chưa nhập gì: gợi ý duyệt theo thể loại
      const genres = state.genres;
      const colors = ['#8d67ab', '#1e3264', '#e8115b', '#148a08', '#dc148c', '#477d95', '#e13300'];
      view.innerHTML = `
        <h1 class="text-2xl font-bold pt-2">Duyệt theo thể loại</h1>
        <div class="${gridClass} mt-4">
          ${genres
            .map(
              (g, i) => `<a href="#/search/${encodeURIComponent(g)}" class="rounded-lg p-4 h-28 font-bold text-xl" style="background:${colors[i % colors.length]}">${esc(g)}</a>`
            )
            .join('')}
        </div>`;
      state.viewSongs = [];
      return;
    }

    const songs = await api(`/api/songs?q=${encodeURIComponent(q)}`);
    const lower = q.toLowerCase();
    const albums = state.albums.filter((a) => a.title.toLowerCase().includes(lower));
    const artists = state.artists.filter((a) => a.name.toLowerCase().includes(lower));

    if (!songs.length && !albums.length && !artists.length) {
      state.viewSongs = [];
      view.innerHTML = emptyState(`Không tìm thấy kết quả cho "${q}"`, 'Hãy kiểm tra chính tả hoặc thử từ khóa khác.');
      return;
    }
    view.innerHTML = `
      ${songs.length ? sectionTitle('Bài hát') + songTable(songs) : ''}
      ${artists.length ? sectionTitle('Nghệ sĩ') + `<div class="${gridClass}">${artists.map(artistCard).join('')}</div>` : ''}
      ${albums.length ? sectionTitle('Album') + `<div class="${gridClass}">${albums.map(albumCard).join('')}</div>` : ''}`;
    if (!songs.length) state.viewSongs = [];
  }

  async function viewPlaylist(id) {
    const pl = await api(`/api/playlists/${id}`);
    state.viewCtx = { playlistId: pl.id };
    renderSidebar(pl.id);
    view.innerHTML = `
      <div class="flex flex-col sm:flex-row sm:items-end gap-5 pt-2">
        <div class="w-44 h-44 md:w-56 md:h-56 rounded-lg bg-raised grid place-items-center text-muted shadow-2xl shrink-0">
          <svg class="w-20 h-20" viewBox="0 0 24 24" fill="currentColor"><path d="M3 6h14v2H3zm0 4h14v2H3zm0 4h9v2H3zm14 0v-2h2v2h2v2h-2v2h-2v-2h-2v-2z"/></svg>
        </div>
        <div class="min-w-0">
          <h1 class="text-4xl md:text-6xl font-extrabold line-2">${esc(pl.name)}</h1>
          <p class="mt-3 text-muted">${pl.songs.length} bài hát</p>
        </div>
      </div>
      <div class="mt-6 flex items-center gap-3">
        ${pl.songs.length ? playButton() : ''}
        ${pl.canEdit ? `<button data-action="rename-playlist" data-id="${pl.id}" class="px-4 py-2 rounded-full border border-line font-semibold hover:bg-raised">Đổi tên</button>
        <button data-action="delete-playlist" data-id="${pl.id}" class="px-4 py-2 rounded-full border border-line font-semibold hover:bg-raised">Xóa playlist</button>` : '<span class="text-sm text-muted">Playlist mẫu</span>'}
      </div>
      ${
        pl.songs.length
          ? songTable(pl.songs, { removable: pl.canEdit })
      : (state.viewSongs = [], emptyState('Playlist đang trống', pl.canEdit ? 'Bấm nút + ở bất kỳ bài hát nào để thêm vào đây, hoặc <a class="underline" href="#/search">tìm bài hát</a>.' : 'Đây là playlist mẫu chỉ xem.'))
      }`;
  }

  function viewPlaylists() {
    state.viewCtx = {};
    state.viewSongs = [];
    view.innerHTML = `
      <div class="flex items-center justify-between pt-2">
        <h1 class="text-2xl font-bold">Playlist của bạn</h1>
        ${state.user ? '<button data-action="new-playlist" class="px-4 py-2 rounded-full bg-accent text-black font-bold">Tạo playlist</button>' : '<a href="#/auth/login" class="px-4 py-2 rounded-full bg-white text-black font-bold">Đăng nhập để tạo playlist</a>'}
      </div>
      <div class="mt-4">
        ${
          state.playlists
            .map(
              (p) => `<a href="#/playlist/${p.id}" class="pl-item">
                <span class="w-12 h-12 rounded bg-raised grid place-items-center text-muted shrink-0">${plIcon()}</span>
                <span class="min-w-0"><span class="block font-semibold truncate">${esc(p.name)}</span>
                <span class="block text-sm text-muted">${p.songs.length} bài hát</span></span></a>`
            )
            .join('') || emptyState('Chưa có playlist', 'Bấm "Tạo playlist" để bắt đầu.')
        }
      </div>`;
  }

  function viewAuth(mode) {
    const register = mode === 'register';
    view.innerHTML = `
      <section class="mx-auto mt-8 max-w-md rounded-xl bg-raised p-6 sm:p-8">
        <h1 class="text-3xl font-extrabold">${register ? 'Tạo tài khoản' : 'Đăng nhập'}</h1>
        <p class="mt-2 text-sm text-muted">${register ? 'Đăng ký để tạo playlist và tải nhạc lên.' : 'Đăng nhập để tiếp tục nghe nhạc của bạn.'}</p>
        <form id="auth-form" class="mt-6 grid gap-4">
          ${register ? `<div><label for="auth-name" class="mb-1 block text-sm font-semibold">Tên hiển thị</label><input id="auth-name" name="name" class="field" minlength="2" maxlength="60" autocomplete="name" required /></div>` : ''}
          <div><label for="auth-email" class="mb-1 block text-sm font-semibold">${register ? 'Email' : 'Email hoặc số điện thoại'}</label><input id="auth-email" name="${register ? 'email' : 'login'}" type="${register ? 'email' : 'text'}" class="field" maxlength="254" autocomplete="${register ? 'email' : 'username'}" required /></div>
          ${register ? `<div><label for="auth-phone" class="mb-1 block text-sm font-semibold">Số điện thoại</label><input id="auth-phone" name="phone" type="tel" class="field" maxlength="20" autocomplete="tel" pattern="(0|\\+84)[0-9]{9,10}" required /></div>` : ''}
          <div><label for="auth-password" class="mb-1 block text-sm font-semibold">Mật khẩu</label><input id="auth-password" name="password" type="password" class="field" minlength="8" maxlength="128" autocomplete="${register ? 'new-password' : 'current-password'}" required /></div>
          <p id="auth-error" class="hidden text-sm text-red-400" role="alert"></p>
          <button id="auth-submit" type="submit" class="rounded-full bg-accent px-5 py-3 font-bold text-black">${register ? 'Đăng ký' : 'Đăng nhập'}</button>
        </form>
        <p class="mt-5 text-sm text-muted">${register ? 'Đã có tài khoản?' : 'Chưa có tài khoản?'}
          <a class="font-semibold text-white underline" href="#/auth/${register ? 'login' : 'register'}">${register ? 'Đăng nhập' : 'Đăng ký'}</a>
        </p>
        ${register ? '' : '<p class="mt-3 text-sm"><a class="font-semibold text-accent underline" href="#/auth/forgot">Quên mật khẩu?</a></p>'}
      </section>`;

    $('#auth-form').addEventListener('submit', async (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      const button = $('#auth-submit');
      const error = $('#auth-error');
      const fields = Object.fromEntries(new FormData(form));
      button.disabled = true;
      button.textContent = register ? 'Đang tạo tài khoản…' : 'Đang đăng nhập…';
      error.classList.add('hidden');
      try {
        const result = await api(`/api/auth/${register ? 'register' : 'login'}`, jsonBody('POST', fields));
        state.user = result.user;
        const favorites = await api('/api/favorites');
        state.favorites = new Set(favorites.map((song) => song.id));
        await refreshPlaylists();
        renderAccountArea();
        updateSupportHotlineDisplay();
        toast(register ? 'Tạo tài khoản thành công' : 'Đăng nhập thành công');
        location.hash = '#/';
      } catch (err) {
        error.textContent = err.message;
        error.classList.remove('hidden');
        button.disabled = false;
        button.textContent = register ? 'Đăng ký' : 'Đăng nhập';
      }
    });
  }

  function viewChangePassword() {
    view.innerHTML = `
      <section class="mx-auto mt-8 max-w-md rounded-xl bg-raised p-6 sm:p-8">
        <h1 class="text-3xl font-extrabold">Đổi mật khẩu</h1>
        <p class="mt-2 text-sm text-muted">Nhập mật khẩu hiện tại để xác nhận danh tính. Sau khi đổi, các phiên đăng nhập khác sẽ bị đăng xuất.</p>
        <form id="change-password-form" class="mt-6 grid gap-4">
          <div><label for="current-password" class="mb-1 block text-sm font-semibold">Mật khẩu hiện tại</label><input id="current-password" name="currentPassword" type="password" class="field" maxlength="128" autocomplete="current-password" required /></div>
          <div><label for="new-password" class="mb-1 block text-sm font-semibold">Mật khẩu mới</label><input id="new-password" name="newPassword" type="password" class="field" minlength="8" maxlength="128" autocomplete="new-password" required /></div>
          <div><label for="confirm-new-password" class="mb-1 block text-sm font-semibold">Nhập lại mật khẩu mới</label><input id="confirm-new-password" name="confirmPassword" type="password" class="field" minlength="8" maxlength="128" autocomplete="new-password" required /></div>
          <p id="change-password-result" class="hidden text-sm" role="status"></p>
          <button id="change-password-submit" type="submit" class="rounded-full bg-accent px-5 py-3 font-bold text-black">Cập nhật mật khẩu</button>
        </form>
        <p class="mt-4 text-sm text-center"><a class="font-semibold text-accent underline" href="#/auth/forgot">Quên mật khẩu?</a></p>
      </section>`;

    $('#change-password-form').addEventListener('submit', async (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      const fields = Object.fromEntries(new FormData(form));
      const result = $('#change-password-result');
      const button = $('#change-password-submit');
      result.classList.add('hidden');
      if (fields.newPassword !== fields.confirmPassword) {
        result.textContent = 'Mật khẩu mới nhập lại không khớp';
        result.classList.remove('hidden', 'text-green-400');
        result.classList.add('text-red-400');
        return;
      }

      button.disabled = true;
      button.textContent = 'Đang cập nhật…';
      try {
        const response = await api('/api/auth/change-password', jsonBody('POST', {
          currentPassword: fields.currentPassword,
          newPassword: fields.newPassword,
        }));
        form.reset();
        result.textContent = response.message;
        result.classList.remove('hidden', 'text-red-400');
        result.classList.add('text-green-400');
      } catch (error) {
        result.textContent = error.message;
        result.classList.remove('hidden', 'text-green-400');
        result.classList.add('text-red-400');
      } finally {
        button.disabled = false;
        button.textContent = 'Cập nhật mật khẩu';
      }
    });
  }

  function viewProfile() {
    const user = state.user;
    const hasPhone = user && user.phone;
    view.innerHTML = `
      <section class="mx-auto mt-8 max-w-md rounded-xl bg-raised p-6 sm:p-8">
        <h1 class="text-3xl font-extrabold">Thông tin bảo mật</h1>
        <p class="mt-2 text-sm text-muted">Quản lý email và số điện thoại của tài khoản. Số điện thoại giúp bạn đăng nhập và phục hồi tài khoản khi mất truy cập email.</p>
        <div class="mt-6 space-y-4">
          <div class="border border-line rounded-lg p-4">
            <p class="text-sm font-semibold text-muted uppercase tracking-wider mb-2">Thông tin hiện tại</p>
            <div class="flex items-center gap-3 mb-2">
              <span class="w-8 h-8 rounded-full bg-accent text-black grid place-items-center text-xs font-bold">@</span>
              <div>
                <p class="font-medium">${esc(user.email)}</p>
                <p class="text-xs text-muted">Email đăng nhập</p>
              </div>
            </div>
            <div class="flex items-center gap-3">
              <span class="w-8 h-8 rounded-full bg-accent text-black grid place-items-center text-xs font-bold">📱</span>
              <div>
                <p class="${hasPhone ? 'font-medium' : 'text-red-400 font-medium'}">${hasPhone ? esc(user.phone) : 'Chưa có số điện thoại'}</p>
                <p class="text-xs text-muted">Số điện thoại liên hệ</p>
              </div>
            </div>
          </div>

          ${!hasPhone ? `
          <div class="border border-amber-300 bg-amber-300/10 rounded-lg p-4">
            <p class="text-sm font-bold text-amber-900 mb-2">🔒 Tăng cường bảo mật tài khoản</p>
            <p class="text-sm text-amber-800 mb-3">Bạn chưa có số điện thoại. Vui lòng thêm số điện thoại để dễ dàng khôi phục tài khoản khi mất quyền truy cập email.</p>
            <button id="btn-add-phone" class="w-full rounded-full bg-amber-300 px-5 py-3 font-bold text-black hover:brightness-110">Thêm số điện thoại</button>
          </div>
          ` : ''}

          <form id="profile-form" class="mt-4 grid gap-4">
            <div><label for="profile-email" class="mb-1 block text-sm font-semibold">Email</label><input id="profile-email" name="email" type="email" class="field" maxlength="254" value="${esc(user.email)}" required /></div>
            <div><label for="profile-phone" class="mb-1 block text-sm font-semibold">Số điện thoại</label><input id="profile-phone" name="phone" type="tel" class="field" maxlength="20" value="${esc(user.phone || '')}" placeholder="0901234567" /></div>
            <p id="profile-error" class="hidden text-sm text-red-400" role="alert"></p>
            <button id="profile-submit" type="submit" class="rounded-full bg-accent px-5 py-3 font-bold text-black">Cập nhật thông tin</button>
          </form>
        </div>
        <p class="mt-5 text-sm"><a class="font-semibold text-white underline" href="#/">Về trang chủ</a></p>
      </section>`;

    if (!hasPhone) {
      $('#btn-add-phone')?.addEventListener('click', () => {
        $('#profile-phone').focus();
      });
    }

    $('#profile-form').addEventListener('submit', async (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      const button = $('#profile-submit');
      const error = $('#profile-error');
      const fields = Object.fromEntries(new FormData(form));
      button.disabled = true;
      button.textContent = 'Đang cập nhật…';
      error.classList.add('hidden');
      try {
        const response = await api('/api/auth/profile', jsonBody('PUT', {
          email: fields.email,
          phone: fields.phone,
        }));
        state.user = response.user;
        renderAccountArea();
        updateSupportHotlineDisplay();
        toast(response.message);
        location.hash = '#/';
      } catch (err) {
        error.textContent = err.message;
        error.classList.remove('hidden');
      } finally {
        button.disabled = false;
        button.textContent = 'Cập nhật thông tin';
      }
    });
  }

  function updateSupportHotlineDisplay() {
    const hotlineNumber = $('#support-hotline-number');
    const userPhoneBox = $('#support-user-phone');
    const userPhoneValue = $('#support-user-phone-value');
    if (!hotlineNumber || !userPhoneBox || !userPhoneValue) return;

    if (state.user && state.user.phone) {
      userPhoneValue.textContent = state.user.phone;
      userPhoneBox.style.display = 'flex';
      hotlineNumber.textContent = '0901 234 567 (Admin)';
    } else {
      userPhoneBox.style.display = 'none';
      hotlineNumber.textContent = '0901 234 567';
    }
  }

  function viewForgotPassword() {
    view.innerHTML = `
      <section class="mx-auto mt-8 max-w-md rounded-xl bg-raised p-6 sm:p-8">
        <h1 class="text-3xl font-extrabold">Quên mật khẩu</h1>
        <p class="mt-2 text-sm text-muted">Nhập email tài khoản để nhận mã xác thực 6 số qua Gmail. Mã có hiệu lực 10 phút.</p>
        <form id="forgot-password-form" class="mt-6 grid gap-4">
          <div><label for="forgot-email" class="mb-1 block text-sm font-semibold">Email tài khoản</label><input id="forgot-email" name="email" type="email" class="field" maxlength="254" autocomplete="email" required /></div>
          <p id="forgot-result" class="hidden text-sm" role="status"></p>
          <button id="forgot-submit" type="submit" class="rounded-full bg-accent px-5 py-3 font-bold text-black">Gửi mã xác thực</button>
        </form>
        <p class="mt-5 text-sm"><a class="font-semibold text-white underline" href="#/auth/login">Quay lại đăng nhập</a></p>
      </section>`;

    const form = $('#forgot-password-form');
    const result = $('#forgot-result');
    const submit = $('#forgot-submit');

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const email = $('#forgot-email').value.trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        result.textContent = 'Vui lòng nhập email hợp lệ';
        result.className = 'text-sm text-red-400';
        result.classList.remove('hidden');
        return;
      }

      submit.disabled = true;
      submit.textContent = 'Đang gửi…';
      result.classList.add('hidden');

      try {
        const response = await api('/api/auth/send-reset-code', jsonBody('POST', { email }));
        result.textContent = response.message;
        result.className = 'text-sm text-green-400';
        result.classList.remove('hidden');

        // Chuyển sang bước nhập mã
        setTimeout(() => {
          viewForgotPasswordVerifyCode(email);
        }, 1500);
      } catch (err) {
        result.textContent = err.message;
        result.className = 'text-sm text-red-400';
        result.classList.remove('hidden');
      } finally {
        submit.disabled = false;
        submit.textContent = 'Gửi mã xác thực';
      }
    });
  }

  function viewForgotPasswordVerifyCode(email) {
    view.innerHTML = `
      <section class="mx-auto mt-8 max-w-md rounded-xl bg-raised p-6 sm:p-8">
        <h1 class="text-3xl font-extrabold">Nhập mã xác thực</h1>
        <p class="mt-2 text-sm text-muted">Mã 6 số đã được gửi đến <strong>${esc(email)}</strong>. Vui lòng kiểm tra hộp thư (kể cả spam).</p>
        <form id="verify-code-form" class="mt-6 grid gap-4">
          <div>
            <label for="verify-code" class="mb-1 block text-sm font-semibold">Mã xác thực</label>
            <input id="verify-code" name="code" type="text" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" class="field text-center text-2xl tracking-widest" autocomplete="one-time-code" required />
          </div>
          <p id="verify-result" class="hidden text-sm" role="status"></p>
          <button id="verify-submit" type="submit" class="rounded-full bg-accent px-5 py-3 font-bold text-black">Xác minh</button>
        </form>
        <p class="mt-4 text-sm text-center"><a class="font-semibold text-accent underline" href="#/auth/forgot">Gửi lại mã</a></p>
      </section>`;

    const form = $('#verify-code-form');
    const result = $('#verify-result');
    const submit = $('#verify-submit');
    const input = $('#verify-code');

    // Auto-focus và auto-format
    input.focus();
    input.addEventListener('input', () => {
      input.value = input.value.replace(/\D/g, '').slice(0, 6);
    });

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const code = input.value.trim();
      if (!/^\d{6}$/.test(code)) {
        result.textContent = 'Vui lòng nhập mã 6 số';
        result.className = 'text-sm text-red-400';
        result.classList.remove('hidden');
        return;
      }

      submit.disabled = true;
      submit.textContent = 'Đang xác minh…';
      result.classList.add('hidden');

      try {
        const response = await api('/api/auth/verify-reset-code', jsonBody('POST', { email, code }));
        // Chuyển đến trang đặt lại mật khẩu với token
        location.hash = `#/auth/reset?token=${encodeURIComponent(response.token)}`;
      } catch (err) {
        result.textContent = err.message;
        result.className = 'text-sm text-red-400';
        result.classList.remove('hidden');
      } finally {
        submit.disabled = false;
        submit.textContent = 'Xác minh';
      }
    });
  }

  function viewResetPassword(token) {
    view.innerHTML = `
      <section class="mx-auto mt-8 max-w-md rounded-xl bg-raised p-6 sm:p-8">
        <h1 class="text-3xl font-extrabold">Đặt lại mật khẩu</h1>
        <p class="mt-2 text-sm text-muted">Liên kết chỉ sử dụng được một lần và hết hạn sau 30 phút.</p>
        ${token ? `
          <form id="reset-password-form" class="mt-6 grid gap-4">
            <div><label for="reset-password" class="mb-1 block text-sm font-semibold">Mật khẩu mới</label><input id="reset-password" name="password" type="password" class="field" minlength="8" maxlength="128" autocomplete="new-password" required /></div>
            <div><label for="reset-password-confirm" class="mb-1 block text-sm font-semibold">Nhập lại mật khẩu mới</label><input id="reset-password-confirm" type="password" class="field" minlength="8" maxlength="128" autocomplete="new-password" required /></div>
            <p id="reset-password-result" class="hidden text-sm" role="alert"></p>
            <button id="reset-password-submit" type="submit" class="rounded-full bg-accent px-5 py-3 font-bold text-black">Lưu mật khẩu mới</button>
          </form>
        ` : '<p class="mt-5 text-sm text-red-400" role="alert">Liên kết đặt lại mật khẩu bị thiếu hoặc không hợp lệ.</p>'}
        <p class="mt-5 text-sm"><a class="font-semibold text-white underline" href="#/auth/login">Quay lại đăng nhập</a></p>
      </section>`;
    const form = $('#reset-password-form');
    if (!form) return;
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const password = $('#reset-password').value;
      const confirmation = $('#reset-password-confirm').value;
      const result = $('#reset-password-result');
      const button = $('#reset-password-submit');
      if (password !== confirmation) {
        result.textContent = 'Hai mật khẩu không khớp.';
        result.className = 'text-sm text-red-400';
        return;
      }
      button.disabled = true;
      result.classList.add('hidden');
      try {
        const response = await api('/api/auth/reset-password', jsonBody('POST', { token, password }));
        state.user = null;
        state.favorites = new Set();
        state.playlists = [];
        renderAccountArea();
        view.innerHTML = `
          <section class="mx-auto mt-8 max-w-md rounded-xl bg-raised p-6 text-center sm:p-8">
            <h1 class="text-2xl font-extrabold">Đã cập nhật mật khẩu</h1>
            <p class="mt-3 text-sm text-muted">${esc(response.message)}</p>
            <a href="#/auth/login" class="mt-5 inline-block rounded-full bg-accent px-5 py-3 font-bold text-black">Đăng nhập</a>
          </section>`;
      } catch (error) {
        result.textContent = error.message;
        result.className = 'text-sm text-red-400';
        result.classList.remove('hidden');
        button.disabled = false;
      }
    });
  }

  function viewUpload() {
    state.viewCtx = {};
    state.viewSongs = [];
    if (!state.user) {
      view.innerHTML = `
        <h1 class="text-3xl font-extrabold pt-2">Tải nhạc lên</h1>
        <p class="mt-3 text-muted">Bạn cần đăng nhập để tải nhạc lên.</p>
        <a href="#/auth/login" class="inline-block mt-5 px-5 py-3 rounded-full bg-accent text-black font-bold">Đăng nhập</a>`;
      return;
    }
    view.innerHTML = `
      <h1 class="text-3xl font-extrabold pt-2">Tải nhạc lên</h1>
      <p class="text-muted mt-1">Hỗ trợ MP3, WAV, OGG, M4A, AAC, FLAC – tối đa 30MB.</p>

      <form id="upload-form" class="mt-6 max-w-xl grid gap-4">
        <div>
          <label class="block text-sm font-semibold mb-1" for="f-audio">File âm thanh</label>
          <input id="f-audio" name="audio" type="file" accept="audio/*,.mp3,.wav,.ogg,.m4a,.aac,.flac" required class="field" />
        </div>
        <div>
          <label class="block text-sm font-semibold mb-1" for="f-title">Tên bài hát</label>
          <input id="f-title" name="title" class="field" maxlength="150" required />
        </div>
        <div>
          <label class="block text-sm font-semibold mb-1" for="f-artist">Nghệ sĩ</label>
          <select id="f-artist" name="artistId" class="field">
            ${state.artists.map((a) => `<option value="${a.id}">${esc(a.name)}</option>`).join('')}
            <option value="">+ Nghệ sĩ mới…</option>
          </select>
          <input id="f-artist-new" name="artistName" class="field mt-2 hidden" placeholder="Tên nghệ sĩ mới" maxlength="100" />
        </div>
        <div class="grid sm:grid-cols-2 gap-4">
          <div>
            <label class="block text-sm font-semibold mb-1" for="f-album">Album (tùy chọn)</label>
            <select id="f-album" name="albumId" class="field">
              <option value="">Không thuộc album</option>
              ${state.albums.map((a) => `<option value="${a.id}">${esc(a.title)}</option>`).join('')}
            </select>
          </div>
          <div>
            <label class="block text-sm font-semibold mb-1" for="f-genre">Thể loại</label>
            <input id="f-genre" name="genre" class="field" maxlength="40" placeholder="Pop, Lofi, EDM…" />
          </div>
        </div>
        <div>
          <label class="block text-sm font-semibold mb-1" for="f-cover">Ảnh bìa (tùy chọn)</label>
          <input id="f-cover" name="cover" type="file" accept="image/png,image/jpeg,image/webp" class="field" />
        </div>
        <input type="hidden" id="f-duration" name="duration" value="0" />

        <div id="upload-progress" class="hidden h-2 rounded-full bg-raised overflow-hidden">
          <div id="upload-bar" class="h-full bg-accent" style="width:0%"></div>
        </div>
        <p id="upload-error" class="text-sm text-red-400 hidden" role="alert"></p>

        <div>
          <button id="upload-submit" type="submit" class="px-6 py-3 rounded-full bg-accent text-black font-bold hover:scale-105 transition-transform">Tải lên</button>
        </div>
      </form>`;

    const form = $('#upload-form');
    const artistSel = $('#f-artist');
    const artistNew = $('#f-artist-new');

    // Chọn "Nghệ sĩ mới" thì hiện ô nhập tên
    const syncArtist = () => {
      const isNew = artistSel.value === '';
      artistNew.classList.toggle('hidden', !isNew);
      artistNew.required = isNew;
    };
    artistSel.addEventListener('change', syncArtist);
    syncArtist();

    // Đọc thời lượng file nhạc ngay ở trình duyệt + gợi ý tên bài từ tên file
    $('#f-audio').addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const titleInput = $('#f-title');
      if (!titleInput.value) titleInput.value = file.name.replace(/\.[^.]+$/, '');
      const probe = new Audio();
      probe.preload = 'metadata';
      probe.src = URL.createObjectURL(file);
      probe.addEventListener('loadedmetadata', () => {
        $('#f-duration').value = Math.round(probe.duration) || 0;
        URL.revokeObjectURL(probe.src);
      });
    });

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const errBox = $('#upload-error');
      const btn = $('#upload-submit');
      errBox.classList.add('hidden');
      btn.disabled = true;
      btn.textContent = 'Đang tải lên…';
      $('#upload-progress').classList.remove('hidden');

      try {
        const fd = new FormData(form);
        if (!fd.get('cover') || !fd.get('cover').size) fd.delete('cover'); // không chọn ảnh thì bỏ field
        await uploadSong(fd, (ratio) => ($('#upload-bar').style.width = `${Math.round(ratio * 100)}%`));
        await loadAll();
        renderSidebar();
        toast('Đã tải bài hát lên');
        location.hash = '#/';
      } catch (err) {
        errBox.textContent = err.message;
        errBox.classList.remove('hidden');
        btn.disabled = false;
        btn.textContent = 'Tải lên';
        $('#upload-progress').classList.add('hidden');
      }
    });
  }

  // Dùng XMLHttpRequest để có thanh tiến trình upload
  function uploadSong(formData, onProgress) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', '/api/songs');
      xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
      xhr.onload = () => {
        let data = {};
        try {
          data = JSON.parse(xhr.responseText);
        } catch {
          /* phản hồi không phải JSON */
        }
        if (xhr.status >= 200 && xhr.status < 300) resolve(data);
        else reject(new Error(data.error || 'Tải lên thất bại'));
      };
      xhr.onerror = () => reject(new Error('Mất kết nối tới máy chủ'));
      xhr.send(formData);
    });
  }

  /* ================================================================ */
  /* 8. ROUTER (hash-based SPA)                                        */
  /* ================================================================ */

  function parseHash() {
    return location.hash
      .replace(/^#/, '')
      .split('/')
      .filter(Boolean)
      .map((p) => decodeURIComponent(p));
  }

  async function route() {
    const [page, arg, subarg] = parseHash();
    state.songLists.clear();
    state.viewSongs = [];

    $$('[data-nav]').forEach((a) =>
      a.classList.toggle('active', a.dataset.nav === (page || 'home'))
    );
    renderSidebar();

    try {
      switch (page) {
        case undefined:
          viewHome();
          break;
        case 'album':
          await viewAlbum(arg);
          break;
        case 'artist':
          await viewArtist(arg);
          break;
        case 'search':
          await viewSearch(arg);
          break;
        case 'favorites':
          viewFavorites();
          break;
        case 'premium':
          if (arg === 'payment' && subarg) await viewPremiumPayment(subarg);
          else viewPremium();
          break;
        case 'vip':
          await viewVipLibrary();
          break;
        case 'playlist':
          await viewPlaylist(arg);
          break;
        case 'playlists':
          viewPlaylists();
          break;
        case 'lyrics':
          renderLyrics();
          break;
        case 'account':
          if (arg === 'profile' && state.user) viewProfile();
          else if (arg === 'profile') location.hash = '#/auth/login';
          else if (arg === 'password' && state.user) viewChangePassword();
          else if (arg === 'password') location.hash = '#/auth/login';
          else view.innerHTML = emptyState('Không tìm thấy trang', '<a class="underline" href="#/">Về trang chủ</a>');
          break;
        case 'upload':
          viewUpload();
          break;
        case 'auth':
          if (state.user && (arg === 'login' || arg === 'register')) {
            location.hash = '#/';
            return;
          }
          if (arg === 'forgot') {
            viewForgotPassword();
          } else if (arg && arg.startsWith('reset')) {
            const query = arg.includes('?') ? arg.slice(arg.indexOf('?') + 1) : '';
            viewResetPassword(new URLSearchParams(query).get('token') || '');
          } else {
            viewAuth(arg === 'register' ? 'register' : 'login');
          }
          break;
        case 'admin':
          if (state.user?.role === 'admin') location.href = '/admin.html';
          else view.innerHTML = emptyState('Không có quyền truy cập', 'Trang quản trị chỉ dành cho tài khoản admin.');
          break;
        default:
          view.innerHTML = emptyState('Không tìm thấy trang', '<a class="underline" href="#/">Về trang chủ</a>');
      }
    } catch (err) {
      state.viewSongs = [];
      view.innerHTML = emptyState('Không tải được nội dung', esc(err.message));
    }
    markPlaying();
    view.scrollTop = 0;
  }

  window.addEventListener('hashchange', route);

  /* ================================================================ */
  /* 9. SỰ KIỆN CHUNG (event delegation)                               */
  /* ================================================================ */

  document.addEventListener('click', async (e) => {
    if (e.target.closest('a')) return; // để liên kết hoạt động bình thường, không kích hoạt phát nhạc
    const target = e.target.closest('[data-action]');
    if (!target) return;
    const id = Number(target.dataset.id);

    switch (target.dataset.action) {
      case 'play-row': {
        const i = Number(target.dataset.index);
        const song = (state.songLists.get(target.dataset.list) || [])[i];
        if (!song) return;
        // Bấm lại đúng bài đang phát thì chỉ chuyển play/pause
        if (currentSong() && currentSong().id === song.id) togglePlay();
        else playList(state.songLists.get(target.dataset.list), i);
        break;
      }
      case 'play-all':
        playList(state.viewSongs, 0);
        break;
      case 'add-to-playlist':
        openAddToPlaylist(id);
        break;
      case 'toggle-favorite':
        try {
          await toggleFavorite(id);
        } catch (err) {
          toast(err.message);
        }
        break;
      case 'select-premium-plan':
        if (Object.hasOwn(premiumPlans, target.dataset.plan)) {
          state.selectedPremiumPlan = target.dataset.plan;
          viewPremium();
        }
        break;
      case 'upgrade-premium':
        await upgradePremium();
        break;
      case 'checkout-premium':
        await checkoutPremium();
        break;
      case 'refresh-premium-payment':
        {
          const paymentHash = `#/premium/payment/${encodeURIComponent(target.dataset.txnRef)}`;
          if (location.hash === paymentHash) await viewPremiumPayment(target.dataset.txnRef);
          else location.hash = paymentHash;
        }
        break;
      case 'open-premium':
        closeModal();
        location.hash = '#/premium';
        break;
      case 'close-modal':
        closeModal();
        break;
      case 'remove-from-playlist':
        removeFromPlaylist(state.viewCtx.playlistId, id);
        break;
      case 'rename-playlist':
        renamePlaylist(id);
        break;
      case 'delete-playlist':
        deletePlaylist(id);
        break;
      case 'new-playlist':
        createPlaylist();
        break;
    }
  });

  $('#account-area').addEventListener('click', async (event) => {
    if (!event.target.closest('#btn-logout')) return;
    try {
      await api('/api/auth/logout', { method: 'POST' });
      state.user = null;
      state.favorites = new Set();
      resetSupportConversation();
      await refreshPlaylists();
      renderAccountArea();
      updateSupportHotlineDisplay();
      toast('Đã đăng xuất');
      route();
    } catch (err) {
      toast(err.message);
    }
  });

  $('#btn-new-playlist').addEventListener('click', createPlaylist);

  // Ô tìm kiếm: gõ xong 300ms thì chuyển sang trang kết quả
  let searchTimer;
  $('#search-input').addEventListener('input', (e) => {
    clearTimeout(searchTimer);
    const q = e.target.value.trim();
    searchTimer = setTimeout(() => {
      location.hash = q ? `#/search/${encodeURIComponent(q)}` : '#/search';
    }, 300);
  });

  /* ================================================================ */
  /* 10. KHỞI ĐỘNG                                                     */
  /* ================================================================ */

  async function init() {
    initSupportWidget();
    let saved = null;
    try {
      saved = localStorage.getItem('music-volume');
    } catch {
      /* bỏ qua */
    }
    if (saved !== null) el.volume.value = saved;
    applyVolume();
    setFill(el.progress);

    view.innerHTML = '<p class="py-10 text-muted">Đang tải…</p>';
    try {
      await loadAll();
    } catch (err) {
      view.innerHTML = emptyState('Không tải được dữ liệu', `Lỗi máy chủ: ${esc(err.message)}`);
      return;
    }
    restorePlayerState();
    route();
    const accountStatusPollTimer = window.setInterval(pollAccountStatus, 5000);
    window.addEventListener('pagehide', () => window.clearInterval(accountStatusPollTimer), { once: true });
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) pollAccountStatus();
    });
  }

  init();
})();