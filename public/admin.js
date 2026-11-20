(() => {
  'use strict';

  const $ = (selector) => document.querySelector(selector);
  const esc = (value) =>
    String(value ?? '').replace(/[&<>"']/g, (char) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]
    );

  let account;
  let data = {
    overview: null, songs: [], albums: [], artists: [], genres: [], users: [],
    premiumRequests: [], supportConversations: [], passwordResetRequests: [], revenue: null, listening: null,
  };
  let selectedSupportId = null;
  let supportMessages = [];
  let supportLastMessageId = 0;
  let supportPolling = false;
  let supportPollErrorShown = false;
  let requestPolling = false;
  let requestPollErrorShown = false;
  const paginatedLists = {
    genres: { page: 1, expanded: false },
    songs: { page: 1, expanded: false },
    albums: { page: 1, expanded: false },
    premiumRequests: { page: 1, expanded: false },
  };
  const INITIAL_LIST_SIZE = 5;
  const PAGE_SIZE = 10;
  let revenuePeriod = 'all';
  let revenueSalesPage = 1;
  let revenuePaymentsPage = 1;
  let listeningPeriod = 'week';
  let analyticsPolling = false;
  let analyticsPollErrorShown = false;
  const currency = new Intl.NumberFormat('vi-VN', {
    style: 'currency',
    currency: 'VND',
    maximumFractionDigits: 0,
  });

  function activateAdminSection(key) {
    const panel = $(`[data-admin-panel="${key}"]`);
    if (!panel) return;
    document.querySelectorAll('[data-admin-panel]').forEach((item) => {
      item.classList.toggle('hidden', item !== panel);
    });
    document.querySelectorAll('[data-admin-section-target]').forEach((button) => {
      const active = button.dataset.adminSectionTarget === key;
      button.classList.toggle('active', active);
      button.setAttribute('aria-current', active ? 'page' : 'false');
    });
  }

  async function api(url, options) {
    const response = await fetch(url, options);
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || 'Có lỗi xảy ra, vui lòng thử lại');
    return result;
  }

  const json = (method, body) => ({
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  let adminMessageTimer;

  function hideAdminMessage() {
    const element = $('#admin-message');
    if (!element) return;
    element.classList.add('hidden');
    element.setAttribute('aria-hidden', 'true');
    window.clearTimeout(adminMessageTimer);
  }

  function message(text, isError = false) {
    const element = $('#admin-message');
    $('#admin-message-text').textContent = text;
    element.classList.remove('hidden');
    element.setAttribute('aria-hidden', 'false');
    $('#admin-message .center-notice-icon').textContent = isError ? '!' : '♪';
    window.clearTimeout(adminMessageTimer);
    adminMessageTimer = window.setTimeout(hideAdminMessage, 4800);
  }

  // Setup close button for admin message
  const adminCloseBtn = $('#admin-message-close');
  if (adminCloseBtn) adminCloseBtn.onclick = hideAdminMessage;

  function confirmAction(text, { title = 'Xác nhận thao tác', confirmLabel = 'Xác nhận', danger = false } = {}) {
    const dialog = $('#admin-confirm-dialog');
    if (dialog.open) return Promise.resolve(false);
    $('#admin-confirm-title').textContent = title;
    $('#admin-confirm-message').textContent = text;
    $('#admin-confirm-accept').textContent = confirmLabel;
    $('#admin-confirm-accept').classList.toggle('bg-red-400', danger);
    $('#admin-confirm-accept').classList.toggle('bg-accent', !danger);
    $('#admin-confirm-icon').textContent = danger ? '!' : '?';
    $('#admin-confirm-icon').classList.toggle('bg-red-400/10', danger);
    $('#admin-confirm-icon').classList.toggle('text-red-300', danger);
    $('#admin-confirm-icon').classList.toggle('bg-accent/10', !danger);
    $('#admin-confirm-icon').classList.toggle('text-accent', !danger);
    return new Promise((resolve) => {
      dialog.addEventListener('close', () => resolve(dialog.returnValue === 'confirm'), { once: true });
      dialog.showModal();
    });
  }

  function showPasswordResetResult({ email, deliveryMethod, url = '' }) {
    const dialog = $('#password-reset-result');
    const sentByEmail = deliveryMethod === 'email';
    $('#password-reset-result-title').textContent = sentByEmail
      ? 'Yêu cầu đã duyệt'
      : 'Yêu cầu đã duyệt — cần gửi link';
    $('#password-reset-result-message').textContent = sentByEmail
      ? `Link đặt lại đã được gửi đến ${email}. Link hết hạn sau 30 phút; người dùng cần mở email và tự đặt mật khẩu mới.`
      : `Sao chép link bên dưới và gửi riêng cho ${email}. Việc duyệt chưa đổi mật khẩu; người dùng phải mở link và tự đặt mật khẩu mới.`;
    $('#password-reset-link-label').classList.toggle('hidden', sentByEmail);
    $('#password-reset-link').classList.toggle('hidden', sentByEmail);
    $('#password-reset-link-help').classList.toggle('hidden', sentByEmail);
    $('#password-reset-copy').classList.toggle('hidden', sentByEmail);
    $('#password-reset-link').value = url;
    $('#password-reset-copy-status').textContent = '';
    dialog.showModal();
  }

  async function loadData() {
    const [overview, songs, albums, artists, genres, users, premiumRequests, supportConversations, passwordResetRequests, revenue, listening] = await Promise.all([
      api('/api/admin/overview'),
      api('/api/admin/songs'),
      api('/api/admin/albums'),
      api('/api/artists'),
      api('/api/admin/genres'),
      api('/api/admin/users'),
      api('/api/admin/premium-requests'),
      api('/api/admin/support/conversations'),
      api('/api/admin/password-reset-requests'),
      api('/api/admin/revenue'),
      api(`/api/admin/listening-analytics?period=${listeningPeriod}`),
    ]);
    data = { overview, songs, albums, artists, genres, users, premiumRequests, supportConversations, passwordResetRequests, revenue, listening };
    render();
  }

  function renderSupportList() {
    const list = $('#support-conversations');
    list.innerHTML = data.supportConversations.map((conversation) => `
      <li>
        <button type="button" data-support-conversation="${conversation.id}" class="w-full p-4 text-left hover:bg-raised ${selectedSupportId === conversation.id ? 'bg-raised' : ''}">
          <span class="flex items-center justify-between gap-2">
            <span class="truncate font-semibold">${esc(conversation.userName)}</span>
            <span class="shrink-0 rounded-full ${conversation.status === 'waiting' ? 'bg-amber-300 text-black' : 'bg-accent text-black'} px-2 py-0.5 text-[10px] font-bold">${conversation.status === 'waiting' ? 'Chờ' : 'Đang hỗ trợ'}</span>
          </span>
          <span class="mt-1 block truncate text-xs text-muted">${esc(conversation.lastMessage || conversation.userEmail || 'Chưa có tin nhắn')}</span>
          <span class="mt-1 block text-[11px] text-muted">${esc(new Date(conversation.updatedAt).toLocaleString('vi-VN'))}</span>
        </button>
      </li>
    `).join('') || '<li class="p-4 text-sm text-muted">Chưa có khách hàng cần hỗ trợ.</li>';
  }

  function renderSupportMessages() {
    const container = $('#support-chat-messages');
    container.replaceChildren();
    if (!selectedSupportId) {
      const empty = document.createElement('p');
      empty.className = 'text-sm text-muted';
      empty.textContent = 'Chọn một khách hàng ở danh sách bên trái để xem tin nhắn.';
      container.append(empty);
      return;
    }
    if (!supportMessages.length) {
      const empty = document.createElement('p');
      empty.className = 'text-sm text-muted';
      empty.textContent = 'Chưa có tin nhắn. Hãy gửi lời chào tới khách hàng.';
      container.append(empty);
      return;
    }
    supportMessages.forEach((item) => {
      const row = document.createElement('div');
      row.className = `flex ${item.senderType === 'admin' ? 'justify-end' : 'justify-start'}`;
      const bubble = document.createElement('div');
      bubble.className = `max-w-[85%] rounded-2xl px-3 py-2 text-sm ${
        item.senderType === 'admin' ? 'bg-accent text-black' : 'bg-raised text-white'
      }`;
      const label = document.createElement('p');
      label.className = 'mb-1 text-[11px] font-bold opacity-70';
      label.textContent = item.senderType === 'admin' ? 'Bạn · Chuyên viên' : 'Khách hàng';
      const body = document.createElement('p');
      body.className = 'whitespace-pre-wrap break-words';
      body.textContent = item.body;
      const timestamp = document.createElement('p');
      timestamp.className = 'mt-1 text-[10px] opacity-60';
      timestamp.textContent = new Date(item.createdAt).toLocaleString('vi-VN');
      bubble.append(label, body, timestamp);
      row.append(bubble);
      container.append(row);
    });
    container.scrollTop = container.scrollHeight;
  }

  async function loadSupportMessages(after = false) {
    if (!selectedSupportId) return;
    const query = after && supportLastMessageId ? `?after=${supportLastMessageId}` : '';
    const result = await api(`/api/admin/support/conversations/${selectedSupportId}/messages${query}`);
    if (!after) supportMessages = [];
    const seen = new Set(supportMessages.map((item) => item.id));
    result.messages.forEach((item) => {
      if (!seen.has(item.id)) supportMessages.push(item);
      supportLastMessageId = Math.max(supportLastMessageId, item.id);
    });
    $('#support-chat-title').textContent = `${result.conversation.userName} · ${result.conversation.userEmail}`;
    $('#support-chat-status').textContent = result.conversation.status === 'waiting'
      ? 'Đang chờ chuyên viên tiếp nhận'
      : result.conversation.status === 'active'
        ? 'Đang trò chuyện'
        : 'Cuộc trò chuyện đã kết thúc';
    const closed = result.conversation.status === 'closed';
    $('#support-reply-input').disabled = closed;
    $('#support-reply-input').placeholder = closed ? 'Cuộc trò chuyện đã kết thúc' : 'Nhập phản hồi…';
    $('#support-reply-send').disabled = closed;
    $('#support-close-conversation').classList.toggle('hidden', closed);
    renderSupportMessages();
  }

  async function pollSupport() {
    if (supportPolling) return;
    supportPolling = true;
    try {
      data.supportConversations = await api('/api/admin/support/conversations');
      renderSupportList();
      if (selectedSupportId) {
        if (!data.supportConversations.some((item) => item.id === selectedSupportId)) {
          await loadSupportMessages(true);
        } else {
          await loadSupportMessages(true);
        }
      }
      supportPollErrorShown = false;
    } catch (error) {
      if (!supportPollErrorShown) message(`Không thể cập nhật hỗ trợ: ${error.message}`, true);
      supportPollErrorShown = true;
    } finally {
      supportPolling = false;
    }
  }

  function renderPagedList(key, items, renderItem, emptyHtml) {
    const state = paginatedLists[key];
    const list = $(`#${key === 'premiumRequests' ? 'premium-request-list' : `${key.slice(0, -1)}-list`}`);
    const controls = $(`#${key === 'premiumRequests' ? 'premium-request-list-pagination' : `${key.slice(0, -1)}-list-pagination`}`);
    const pageSize = state.expanded ? PAGE_SIZE : INITIAL_LIST_SIZE;
    const pageCount = Math.max(1, Math.ceil(items.length / PAGE_SIZE));
    state.page = Math.min(state.page, pageCount);
    const start = state.expanded ? (state.page - 1) * PAGE_SIZE : 0;
    const visibleItems = items.slice(start, start + pageSize);
    list.innerHTML = visibleItems.map(renderItem).join('') || emptyHtml;

    if (items.length <= INITIAL_LIST_SIZE) {
      controls.innerHTML = '';
      return;
    }

    if (!state.expanded) {
      controls.innerHTML = `
        <button type="button" data-admin-list-more="${key}" class="rounded-full border border-line px-4 py-2 text-sm font-semibold hover:bg-raised">
          Xem thêm (${Math.min(PAGE_SIZE, items.length)} mục)
        </button>`;
      return;
    }

    const pagination = pageCount > 1 ? `
      <nav class="flex flex-wrap items-center gap-2" aria-label="Phân trang ${key}">
        <button type="button" data-admin-list-page="${key}" data-page="${state.page - 1}" class="rounded-full border border-line px-3 py-1 text-sm hover:bg-raised disabled:opacity-40" ${state.page === 1 ? 'disabled' : ''}>Trước</button>
        ${Array.from({ length: pageCount }, (_, index) => index + 1).map((page) => `
          <button type="button" data-admin-list-page="${key}" data-page="${page}" aria-current="${page === state.page ? 'page' : 'false'}" class="rounded-full ${page === state.page ? 'bg-accent text-black' : 'border border-line hover:bg-raised'} px-3 py-1 text-sm font-semibold">${page}</button>
        `).join('')}
        <button type="button" data-admin-list-page="${key}" data-page="${state.page + 1}" class="rounded-full border border-line px-3 py-1 text-sm hover:bg-raised disabled:opacity-40" ${state.page === pageCount ? 'disabled' : ''}>Sau</button>
        <span class="ml-1 text-sm text-muted">Trang ${state.page}/${pageCount} · ${items.length} mục</span>
      </nav>` : `<span class="text-sm text-muted">${items.length} mục</span>`;
    controls.innerHTML = `
      <div class="flex flex-wrap items-center justify-between gap-3">
        ${pagination}
        <button type="button" data-admin-list-collapse="${key}" class="text-sm text-muted underline hover:text-white">Thu gọn</button>
      </div>`;
  }

  function renderRequestLists() {
    const planNames = { month: '1 tháng', halfYear: '6 tháng', year: '12 tháng' };
    const requestStatus = { pending: 'Chờ duyệt', approved: 'Đã duyệt', rejected: 'Từ chối' };
    const paymentStatus = {
      pending: 'Chờ VNPay xác nhận',
      expired: 'Đơn hết hạn, chưa hoàn tất',
      paid: 'Đã thanh toán Sandbox',
      failed: 'Thanh toán thất bại',
    };
    renderPagedList('premiumRequests', data.premiumRequests, (request) => `
      <tr class="border-t border-line">
        <td class="p-2">${esc(request.userName)}</td>
        <td class="p-2">${esc(request.userEmail)}</td>
        <td class="p-2">${esc(planNames[request.plan] || request.plan)}</td>
        <td class="p-2">${Number(request.price).toLocaleString('vi-VN')}đ</td>
        <td class="p-2">${esc(new Date(request.createdAt).toLocaleString('vi-VN'))}</td>
        <td class="p-2">${esc(request.payment
          ? paymentStatus[request.payment.status] || request.payment.status
          : requestStatus[request.status] || request.status)}
          ${request.payment ? `<span class="block break-all text-xs text-muted">${esc(request.payment.txnRef)}${request.payment.responseCode ? ` · ${esc(request.payment.responseCode)}` : ''}</span>` : ''}
        </td>
        <td class="p-2">${request.status === 'pending' && !request.payment ? `
          <div class="flex flex-wrap gap-2">
            <button data-review-premium="${request.id}" data-review-action="approve" class="rounded-full bg-accent px-3 py-1 font-bold text-black">Duyệt</button>
            <button data-review-premium="${request.id}" data-review-action="reject" class="rounded-full border border-line px-3 py-1 text-red-300">Từ chối</button>
          </div>` : request.payment?.status === 'pending'
          ? 'Chờ VNPay, không thể duyệt thủ công'
          : request.payment?.status === 'expired'
            ? 'Đơn hết hạn; kết quả VNPay đến muộn vẫn được đối soát'
            : '—'}</td>
      </tr>
    `, '<tr><td class="p-3 text-muted" colspan="7">Chưa có yêu cầu nâng cấp.</td></tr>');

    const resetRequestStatus = { pending: 'Chờ duyệt', approved: 'Đã duyệt', rejected: 'Đã từ chối' };
    $('#password-reset-request-list').innerHTML = data.passwordResetRequests.map((request) => `
      <tr class="border-t border-line">
        <td class="p-2">${esc(request.userName)}</td>
        <td class="p-2">${esc(request.userEmail)}</td>
        <td class="p-2">${esc(new Date(request.createdAt).toLocaleString('vi-VN'))}</td>
        <td class="p-2">${esc(resetRequestStatus[request.status] || request.status)}</td>
        <td class="p-2">${request.status === 'pending' ? `
          <div class="flex flex-wrap gap-2">
            <button data-review-password-reset="${request.id}" data-review-action="approve" class="rounded-full bg-accent px-3 py-1 font-bold text-black">Duyệt & tạo link</button>
            <button data-review-password-reset="${request.id}" data-review-action="reject" class="rounded-full border border-line px-3 py-1 text-red-300">Từ chối</button>
          </div>` : '—'}</td>
      </tr>
    `).join('') || '<tr><td class="p-3 text-muted" colspan="5">Chưa có yêu cầu đặt lại mật khẩu.</td></tr>';
  }

  async function pollAdminRequests() {
    if (requestPolling || document.hidden) return;
    requestPolling = true;
    try {
      const [premiumRequests, passwordResetRequests] = await Promise.all([
        api('/api/admin/premium-requests'),
        api('/api/admin/password-reset-requests'),
      ]);
      const knownPendingPremiumIds = new Set(
        data.premiumRequests.filter((request) => request.status === 'pending').map((request) => request.id)
      );
      const knownPendingResetIds = new Set(
        data.passwordResetRequests.filter((request) => request.status === 'pending').map((request) => request.id)
      );
      const newPremiumCount = premiumRequests.filter(
        (request) => request.status === 'pending' && !knownPendingPremiumIds.has(request.id)
      ).length;
      const newResetCount = passwordResetRequests.filter(
        (request) => request.status === 'pending' && !knownPendingResetIds.has(request.id)
      ).length;
      const requestsChanged =
        JSON.stringify(data.premiumRequests) !== JSON.stringify(premiumRequests) ||
        JSON.stringify(data.passwordResetRequests) !== JSON.stringify(passwordResetRequests);

      data.premiumRequests = premiumRequests;
      data.passwordResetRequests = passwordResetRequests;
      if (newPremiumCount) paginatedLists.premiumRequests.page = 1;
      if (requestsChanged) renderRequestLists();
      if (requestsChanged) {
        data.revenue = await api('/api/admin/revenue');
        renderRevenue();
      }
      if (newPremiumCount || newResetCount) {
        const notices = [];
        if (newPremiumCount) notices.push(`${newPremiumCount} yêu cầu VIP mới`);
        if (newResetCount) notices.push(`${newResetCount} yêu cầu đặt lại mật khẩu mới`);
        message(`Có ${notices.join(' và ')}.`);
      }
      requestPollErrorShown = false;
    } catch (error) {
      if (!requestPollErrorShown) message(`Không thể cập nhật yêu cầu: ${error.message}`, true);
      requestPollErrorShown = true;
    } finally {
      requestPolling = false;
    }
  }

  async function pollAdminAnalytics() {
    if (analyticsPolling || document.hidden) return;
    analyticsPolling = true;
    try {
      const [overview, listening, revenue] = await Promise.all([
        api('/api/admin/overview'),
        api(`/api/admin/listening-analytics?period=${listeningPeriod}`),
        api('/api/admin/revenue'),
      ]);
      data.overview = overview;
      data.listening = listening;
      data.revenue = revenue;
      renderOverview();
      renderRevenue();
      analyticsPollErrorShown = false;
    } catch (error) {
      if (!analyticsPollErrorShown) message(`Không thể cập nhật số liệu tổng quan: ${error.message}`, true);
      analyticsPollErrorShown = true;
    } finally {
      analyticsPolling = false;
    }
  }

  function renderCatalogLists() {
    const newestSongs = data.songs.slice().sort((a, b) => b.id - a.id);
    renderPagedList('songs', newestSongs, (song) => `
      <tr class="border-t border-line">
        <td class="p-2">${esc(song.title)}</td><td class="p-2">${esc(song.artistName)}</td><td class="p-2">${esc(song.genre)}</td><td class="p-2">${song.plays || 0}</td>
        <td class="p-2"><label class="inline-flex items-center gap-2"><input type="checkbox" data-song-vip="${song.id}" ${song.isVip ? 'checked' : ''} aria-label="Đánh dấu ${esc(song.title)} là bài hát VIP" /><span>${song.isVip ? 'VIP' : 'Thường'}</span></label></td>
        <td class="p-2"><div class="flex flex-wrap gap-2">
          <button data-edit-song="${song.id}" class="rounded-full border border-line px-3 py-1 hover:bg-raised">Sửa</button>
          <button data-toggle-trending="${song.id}" data-trending-active="${song.isTrending ? 'true' : 'false'}" class="rounded-full border ${song.isTrending ? 'border-accent text-accent' : 'border-line hover:bg-raised'} px-3 py-1">${song.isTrending ? 'Bỏ trend' : 'Đề cử trend'}</button>
          <button data-delete-song="${song.id}" class="rounded-full border border-line px-3 py-1 text-red-300 hover:bg-raised">Xóa</button>
        </div></td>
      </tr>
    `, '<tr><td class="p-3 text-muted" colspan="6">Chưa có bài hát.</td></tr>');

    const newestAlbums = data.albums.slice().sort((a, b) => b.id - a.id);
    renderPagedList('albums', newestAlbums, (album) => `
      <tr class="border-t border-line">
        <td class="p-2">${esc(album.title)}</td><td class="p-2">${esc(album.artistName)}</td><td class="p-2">${album.year}</td>
        <td class="p-2"><button data-edit-album="${album.id}" class="mr-2 rounded-full border border-line px-3 py-1 hover:bg-raised">Sửa</button><button data-delete-album="${album.id}" class="rounded-full border border-line px-3 py-1 text-red-300 hover:bg-raised">Xóa</button></td>
      </tr>
    `, '<tr><td class="p-3 text-muted" colspan="4">Chưa có album.</td></tr>');

    const recentlyUsedGenres = [...new Set(
      newestSongs.map((song) => song.genre).filter((genre) => data.genres.includes(genre))
    )];
    const newestGenres = [
      ...recentlyUsedGenres,
      ...data.genres.filter((genre) => !recentlyUsedGenres.includes(genre)).sort((a, b) => a.localeCompare(b, 'vi')),
    ];
    renderPagedList('genres', newestGenres, (genre) => `
      <span class="flex items-center gap-2 rounded-full bg-raised px-3 py-2 text-sm">
        ${esc(genre)}<button data-edit-genre="${esc(genre)}" aria-label="Đổi tên ${esc(genre)}" class="font-bold hover:text-accent">Sửa</button><button data-delete-genre="${esc(genre)}" aria-label="Xóa ${esc(genre)}" class="font-bold hover:text-red-300">×</button>
      </span>
    `, '<p class="text-sm text-muted">Chưa có thể loại.</p>');
  }

  function render() {
    renderOverview();

    $('#user-list').innerHTML = data.users.map((user) => `
      <tr class="border-t border-line">
        <td class="p-2">${esc(user.name)}${user.id === account.id ? ' (bạn)' : ''}</td><td class="p-2">${esc(user.email)}</td>
        <td class="p-2"><select data-role="${user.id}" class="field py-1" ${user.id === account.id ? 'disabled' : ''}><option value="user" ${user.role === 'user' ? 'selected' : ''}>User</option><option value="admin" ${user.role === 'admin' ? 'selected' : ''}>Admin</option></select></td>
        <td class="p-2"><select data-status="${user.id}" class="field py-1" ${user.id === account.id ? 'disabled' : ''}><option value="active" ${user.status === 'active' ? 'selected' : ''}>Hoạt động</option><option value="blocked" ${user.status === 'blocked' ? 'selected' : ''}>Đã khóa</option></select></td>
        <td class="p-2">${user.isPremium ? `<span class="rounded-full bg-amber-300 px-2 py-1 text-xs font-bold text-black">VIP</span><span class="mt-1 block text-xs text-muted">${user.premiumExpiresAt ? `Hết hạn ${esc(new Date(user.premiumExpiresAt).toLocaleDateString('vi-VN'))}` : 'Không thời hạn'}</span>` : '<span class="text-muted">Free</span>'}</td>
        <td class="p-2"><div class="flex flex-wrap gap-2">
          <button data-toggle-premium="${user.id}" data-premium-active="${user.isPremium ? 'true' : 'false'}" class="rounded-full border border-line px-3 py-1 hover:bg-raised">${user.isPremium ? 'Hủy VIP' : 'Cấp VIP 1 tháng'}</button>
          <button data-reset-password="${user.id}" class="rounded-full border border-amber-300 px-3 py-1 text-amber-200 hover:bg-raised">Tạo link đặt lại mật khẩu</button>
          <button data-save-user="${user.id}" class="rounded-full border border-line px-3 py-1 hover:bg-raised" ${user.id === account.id ? 'disabled' : ''}>Lưu quyền</button>
        </div></td>
      </tr>
    `).join('') || '<tr><td class="p-3 text-muted" colspan="6">Chưa có tài khoản.</td></tr>';

    $('#album-form [name="artistId"]').innerHTML = data.artists
      .map((artist) => `<option value="${artist.id}">${esc(artist.name)}</option>`).join('');
    $('#song-form [name="albumId"]').innerHTML = '<option value="">Không thuộc album</option>' +
      data.albums.map((album) => `<option value="${album.id}">${esc(album.title)}</option>`).join('');
    renderCatalogLists();
    renderRequestLists();
    renderSupportList();
    renderSupportMessages();
    renderRevenue();
  }

  function renderDashboardChart(selector, items, valueKey, kind) {
    const values = items || [];
    const max = Math.max(0, ...values.map((item) => Number(item[valueKey]) || 0));
    const total = values.reduce((sum, item) => sum + (Number(item[valueKey]) || 0), 0);
    const formatValue = (value) => kind === 'currency' ? currency.format(value) : `${value.toLocaleString('vi-VN')} lượt`;
    const compactValue = (value) => kind === 'currency'
      ? value >= 1_000_000
        ? `${(value / 1_000_000).toFixed(1).replace(/\\.0$/, '')}tr`
        : value >= 1_000
          ? `${Math.round(value / 1_000)}k`
          : String(value)
      : String(value);
    $(selector).innerHTML = values.map((item) => {
      const key = item.key || item.date;
      const date = key.length === 13
        ? new Date(`${key}:00:00Z`)
        : key.length === 7
          ? new Date(`${key}-01T00:00:00Z`)
          : key.length === 10
            ? new Date(`${key}T00:00:00Z`)
            : new Date(key);
      const label = item.granularity === 'month' || key.length === 7
        ? date.toLocaleDateString('vi-VN', { month: '2-digit', year: '2-digit', timeZone: 'UTC' })
        : key.length === 13
        ? new Intl.DateTimeFormat('vi-VN', { hour: '2-digit', timeZone: 'UTC' }).format(date)
        : date.toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit', timeZone: 'UTC' });
      const value = Number(item[valueKey]) || 0;
      const height = max === 0 ? 0 : Math.max(value > 0 ? 3 : 0, value / max * 100);
      return `
        <div class="revenue-chart-column" title="${esc(`${key} · ${formatValue(value)}`)}">
          <span class="revenue-chart-value">${esc(compactValue(value))}</span>
          <div class="revenue-chart-track"><div class="revenue-chart-bar" style="height:${height}%"></div></div>
          <span class="revenue-chart-date">${esc(label)}</span>
        </div>`;
    }).join('') || '<p class="text-sm text-muted">Chưa có dữ liệu.</p>';
    return { total, formatValue };
  }

  function renderOverview() {
    if (!data.overview) return;
    const stats = [
      ['Bài hát', data.overview.songCount, `${data.overview.vipSongCount} bài VIP`],
      ['Tài khoản', data.overview.userCount, `${data.overview.activeUserCount} hoạt động · ${data.overview.blockedUserCount} bị khóa`],
      ['Tài khoản VIP', data.overview.premiumUserCount, 'Còn thời hạn sử dụng'],
      ['Album', data.overview.albumCount, `${data.overview.genreCount} thể loại`],
      ['Yêu cầu VIP chờ', data.overview.pendingPremiumCount, 'Cần được xử lý'],
      ['Hội thoại hỗ trợ mở', data.overview.openSupportCount, 'Đang chờ hoặc đang hỗ trợ'],
    ];
    $('#admin-stats').innerHTML = stats.map(([label, count, detail]) => `
      <article class="rounded-xl bg-panel p-5">
        <p class="text-sm text-muted">${esc(label)}</p>
        <p class="mt-1 text-3xl font-extrabold">${Number(count || 0).toLocaleString('vi-VN')}</p>
        <p class="mt-1 text-xs text-muted">${esc(detail)}</p>
      </article>
    `).join('');

    const revenueChart = renderDashboardChart('#overview-revenue-chart', data.revenue?.charts?.all, 'amount', 'currency');
    $('#overview-revenue-total').textContent = revenueChart.formatValue(revenueChart.total);
    if (!data.listening) return;
    $('#overview-listening-period').value = listeningPeriod;
    renderDashboardChart('#overview-listening-chart', data.listening.chart, 'listenCount', 'count');
    $('#listening-summary').innerHTML = `
      <span><strong>${Number(data.listening.summary.listenCount).toLocaleString('vi-VN')}</strong> lượt nghe</span>
      <span><strong>${Number(data.listening.summary.uniqueListeners).toLocaleString('vi-VN')}</strong> tài khoản đã nghe</span>
    `;
    $('#listening-history-count').textContent =
      `${data.listening.recent.length} bản ghi gần đây · ${data.listening.periodLabel}`;
    $('#overview-updated-at').textContent = new Date(data.listening.generatedAt).toLocaleString('vi-VN');

    const genreStats = data.overview.genreStats || [];
    const maxGenreCount = Math.max(1, ...genreStats.map((item) => item.songCount));
    $('#overview-genre-breakdown').innerHTML = genreStats.length
      ? genreStats.map((item) => `
        <div>
          <div class="mb-1 flex justify-between gap-3 text-sm"><span class="truncate">${esc(item.genre)}</span><strong>${item.songCount}</strong></div>
          <div class="h-2 overflow-hidden rounded-full bg-raised"><div class="h-full rounded-full bg-accent" style="width:${item.songCount / maxGenreCount * 100}%"></div></div>
        </div>`).join('')
      : '<p class="text-sm text-muted">Chưa có bài hát để thống kê thể loại.</p>';

    const topSongs = data.overview.topSongs || [];
    const topSongIds = new Set(topSongs.map((song) => song.id));
    const suggestedSongs = [
      ...topSongs,
      ...(data.overview.trendingSongs || []).filter((song) => !topSongIds.has(song.id)),
    ];
    $('#top-songs').innerHTML = suggestedSongs.length
      ? suggestedSongs.map((song, index) => `
        <li class="flex flex-wrap items-center justify-between gap-3 border-b border-line pb-3 last:border-0">
          <div class="min-w-0">
            <p class="truncate font-semibold">${index < topSongs.length ? `${index + 1}. ` : ''}${esc(song.title)} <span class="font-normal text-muted">— ${esc(song.artistName)}</span></p>
            <p class="mt-1 text-xs text-muted">${Number(song.plays || 0).toLocaleString('vi-VN')} lượt nghe tổng · ${song.isTrending ? 'Đã đề cử lên trang chủ' : index < topSongs.length ? 'Đang được gợi ý tự động' : 'Đề cử thủ công'}</p>
          </div>
          <button type="button" data-toggle-trending="${song.id}" data-trending-active="${song.isTrending ? 'true' : 'false'}" class="shrink-0 rounded-full border ${song.isTrending ? 'border-accent text-accent' : 'border-line hover:bg-raised'} px-3 py-1 text-xs font-semibold">
            ${song.isTrending ? 'Bỏ đề cử' : 'Đề cử làm trend'}
          </button>
        </li>`).join('')
      : '<li class="text-sm text-muted">Chưa có dữ liệu lượt nghe để gợi ý bài trend.</li>';

    $('#listening-period-top').innerHTML = (data.listening.topSongs || []).length
      ? `<p class="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">Nghe nhiều trong ${esc(data.listening.periodLabel.toLowerCase())}</p>
        <ol class="grid gap-2 sm:grid-cols-2">${data.listening.topSongs.slice(0, 4).map((song, index) => `
          <li class="truncate text-sm"><span class="mr-2 text-accent">${index + 1}.</span>${esc(song.title)} <span class="text-muted">· ${song.listenCount} lượt</span></li>
        `).join('')}</ol>`
      : '<p class="text-xs text-muted">Chưa có lượt nghe từ tài khoản đăng nhập trong khoảng này.</p>';

    $('#listening-history-list').innerHTML = data.listening.recent.map((event) => `
      <tr class="border-t border-line">
        <td class="p-3">${esc(event.userName)}</td>
        <td class="p-3">${esc(event.userEmail)}</td>
        <td class="p-3 font-semibold">${esc(event.songTitle)}</td>
        <td class="p-3">${esc(event.artistName)}</td>
        <td class="p-3 whitespace-nowrap">${esc(new Date(event.playedAt).toLocaleString('vi-VN'))}</td>
      </tr>
    `).join('') || '<tr><td class="p-3 text-muted" colspan="5">Chưa có lịch sử nghe. Bản ghi chỉ được tạo khi tài khoản đăng nhập bắt đầu phát bài hát.</td></tr>';
  }

  function renderRevenue() {
    if (!data.revenue) return;
    const periodLabels = {
      all: 'Toàn bộ lịch sử',
      day: '24 giờ qua',
      week: '7 ngày qua',
      month: '30 ngày qua',
      halfYear: '6 tháng qua',
      year: '12 tháng qua',
    };
    $('#revenue-period-totals').innerHTML = Object.entries(periodLabels)
      .map(([key, label]) => `
      <button type="button" data-revenue-period="${key}" aria-pressed="${revenuePeriod === key}" class="revenue-period-card rounded-xl border border-line bg-raised p-4 text-left ${revenuePeriod === key ? 'selected' : ''}">
        <p class="text-sm text-muted">${label}</p>
        <p class="mt-2 text-xl font-extrabold text-accent">${currency.format(data.revenue.totals[key] || 0)}</p>
      </button>
    `).join('');
    $('#revenue-sales-period').value = revenuePeriod;

    const chart = data.revenue.charts?.[revenuePeriod] || [];
    const max = Math.max(0, ...chart.map((item) => item.amount));
    $('#revenue-chart-heading').textContent = `Doanh thu — ${periodLabels[revenuePeriod]}`;
    $('#revenue-chart-total').textContent =
      `Tổng ${periodLabels[revenuePeriod]}: ${currency.format(data.revenue.totals[revenuePeriod] || 0)}`;
    $('#revenue-chart').innerHTML = chart.map((item) => {
      const height = max === 0 ? 0 : Math.max(item.amount > 0 ? 3 : 0, item.amount / max * 100);
      const shortAmount = item.amount >= 1_000_000
        ? `${(item.amount / 1_000_000).toFixed(1).replace(/\\.0$/, '')}tr`
        : item.amount >= 1_000
          ? `${Math.round(item.amount / 1_000)}k`
          : String(item.amount);
      const date = new Date(item.date);
      const dateLabel = item.granularity === 'hour'
        ? date.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' })
        : item.granularity === 'month'
          ? date.toLocaleDateString('vi-VN', { month: '2-digit', year: '2-digit', timeZone: 'UTC' })
          : date.toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit', timeZone: 'UTC' });
      return `
        <div class="revenue-chart-column" title="${esc(dateLabel)} — ${esc(currency.format(item.amount))}">
          <span class="revenue-chart-value">${esc(shortAmount)}</span>
          <div class="revenue-chart-track"><div class="revenue-chart-bar" style="height:${height}%"></div></div>
          <span class="revenue-chart-date">${esc(dateLabel)}</span>
        </div>
      `;
    }).join('');
    $('#revenue-updated-at').textContent = `Cập nhật: ${new Date(data.revenue.generatedAt).toLocaleString('vi-VN')}`;
    renderRevenueSales();
    renderRevenuePayments();
  }

  function renderRevenueSales() {
    if (!data.revenue) return;
    const periodDurations = {
      day: 24 * 60 * 60 * 1000,
      week: 7 * 24 * 60 * 60 * 1000,
      month: 30 * 24 * 60 * 60 * 1000,
      halfYear: 183 * 24 * 60 * 60 * 1000,
      year: 365 * 24 * 60 * 60 * 1000,
    };
    const now = Date.parse(data.revenue.generatedAt);
    const sales = (data.revenue.sales || []).filter((sale) => {
      if (revenuePeriod === 'all') return true;
      const timestamp = Date.parse(sale.reviewedAt);
      return timestamp >= now - periodDurations[revenuePeriod] && timestamp <= now;
    });
    const pageCount = Math.ceil(sales.length / PAGE_SIZE);
    revenueSalesPage = Math.min(Math.max(revenueSalesPage, 1), Math.max(pageCount, 1));
    const pageSales = sales.slice((revenueSalesPage - 1) * PAGE_SIZE, revenueSalesPage * PAGE_SIZE);
    const planNames = { month: '1 tháng', halfYear: '6 tháng', year: '12 tháng' };
    $('#revenue-sales-caption').textContent = `${periodLabelsForRevenue[revenuePeriod]} · ${sales.length} yêu cầu đã duyệt`;
    $('#revenue-sales-list').innerHTML = pageSales.map((sale) => `
      <tr class="border-t border-line">
        <td class="p-3">${esc(sale.userName)}</td>
        <td class="p-3">${esc(sale.userEmail)}</td>
        <td class="p-3">${esc(planNames[sale.plan] || sale.plan)}</td>
        <td class="p-3 font-semibold text-accent">${currency.format(sale.amount)}</td>
        <td class="p-3">${esc(new Date(sale.reviewedAt).toLocaleString('vi-VN'))}</td>
      </tr>
    `).join('') || '<tr><td class="p-3 text-muted" colspan="5">Chưa có yêu cầu VIP đã duyệt trong khoảng thời gian này.</td></tr>';
    $('#revenue-sales-pagination').innerHTML = pageCount > 1 ? `
      <div class="flex flex-wrap items-center gap-2">
        <button type="button" data-revenue-sales-page="${revenueSalesPage - 1}" class="rounded-full border border-line px-3 py-1 text-sm disabled:opacity-40" ${revenueSalesPage === 1 ? 'disabled' : ''}>Trước</button>
        <span class="text-sm text-muted">Trang ${revenueSalesPage}/${pageCount} · ${sales.length} mục</span>
        <button type="button" data-revenue-sales-page="${revenueSalesPage + 1}" class="rounded-full border border-line px-3 py-1 text-sm disabled:opacity-40" ${revenueSalesPage === pageCount ? 'disabled' : ''}>Sau</button>
      </div>
    ` : `<span class="text-sm text-muted">${sales.length} mục</span>`;
  }

  function renderRevenuePayments() {
    if (!data.revenue) return;
    const periodDurations = {
      day: 24 * 60 * 60 * 1000,
      week: 7 * 24 * 60 * 60 * 1000,
      month: 30 * 24 * 60 * 60 * 1000,
      halfYear: 183 * 24 * 60 * 60 * 1000,
      year: 365 * 24 * 60 * 60 * 1000,
    };
    const now = Date.parse(data.revenue.generatedAt);
    const payments = (data.revenue.payments || []).filter((payment) => {
      if (revenuePeriod === 'all') return true;
      const timestamp = Date.parse(payment.createdAt);
      return timestamp >= now - periodDurations[revenuePeriod] && timestamp <= now;
    });
    const pageCount = Math.ceil(payments.length / PAGE_SIZE);
    revenuePaymentsPage = Math.min(Math.max(revenuePaymentsPage, 1), Math.max(pageCount, 1));
    const pagePayments = payments.slice((revenuePaymentsPage - 1) * PAGE_SIZE, revenuePaymentsPage * PAGE_SIZE);
    const planNames = { month: '1 tháng', halfYear: '6 tháng', year: '12 tháng' };
    const statusNames = { pending: 'Đang chờ', paid: 'Đã thanh toán', failed: 'Thất bại' };
    $('#revenue-payment-list').innerHTML = pagePayments.map((payment) => `
      <tr class="border-t border-line align-top">
        <td class="p-3">${esc(payment.userName)}</td>
        <td class="p-3">${esc(payment.userEmail)}</td>
        <td class="p-3">${esc(planNames[payment.plan] || payment.plan)}</td>
        <td class="p-3 font-semibold">${currency.format(payment.amount)}</td>
        <td class="p-3">${esc(statusNames[payment.status] || payment.status)}<span class="block text-xs text-muted">${esc([payment.responseCode, payment.transactionStatus].filter(Boolean).join(' / ') || 'Chưa có mã phản hồi')}</span></td>
        <td class="p-3 break-all">${esc(payment.txnRef)}</td>
        <td class="p-3 break-all">${esc(payment.transactionNo || '—')}</td>
        <td class="p-3">${esc([payment.bankCode, payment.cardType].filter(Boolean).join(' / ') || '—')}</td>
        <td class="p-3 whitespace-nowrap">Tạo: ${esc(new Date(payment.createdAt).toLocaleString('vi-VN'))}<span class="mt-1 block text-xs text-muted">IPN: ${esc(payment.callbackAt ? new Date(payment.callbackAt).toLocaleString('vi-VN') : 'Đang chờ')}</span></td>
        <td class="p-3">${payment.vipActivated ? 'Đã kích hoạt' : 'Chưa kích hoạt'}</td>
        <td class="p-3"><details><summary class="cursor-pointer whitespace-nowrap text-accent">Mở dữ liệu</summary><pre class="mt-2 max-w-md whitespace-pre-wrap break-all rounded bg-base p-3 text-xs">${esc(JSON.stringify(payment, null, 2))}</pre></details></td>
      </tr>
    `).join('') || '<tr><td class="p-3 text-muted" colspan="11">Chưa có giao dịch VNPay nào.</td></tr>';
    $('#revenue-payment-pagination').innerHTML = pageCount > 1 ? `
      <div class="flex flex-wrap items-center gap-2">
        <button type="button" data-revenue-payment-page="${revenuePaymentsPage - 1}" class="rounded-full border border-line px-3 py-1 text-sm disabled:opacity-40" ${revenuePaymentsPage === 1 ? 'disabled' : ''}>Trước</button>
        <span class="text-sm text-muted">Trang ${revenuePaymentsPage}/${pageCount} · ${payments.length} giao dịch</span>
        <button type="button" data-revenue-payment-page="${revenuePaymentsPage + 1}" class="rounded-full border border-line px-3 py-1 text-sm disabled:opacity-40" ${revenuePaymentsPage === pageCount ? 'disabled' : ''}>Sau</button>
      </div>
    ` : `<span class="text-sm text-muted">${payments.length} giao dịch</span>`;
  }

  const periodLabelsForRevenue = {
    all: 'Toàn bộ lịch sử',
    day: '24 giờ qua',
    week: '7 ngày qua',
    month: '30 ngày qua',
    halfYear: '6 tháng qua',
    year: '12 tháng qua',
  };

  $('#song-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const fields = Object.fromEntries(new FormData(form));
    fields.duration = Number(fields.duration) || 0;
    fields.albumId = fields.albumId || null;
    fields.isVip = form.elements.isVip.checked;
    if (!await confirmAction(`Thêm bài hát "${fields.title}" vào thư viện?`, {
      title: 'Thêm bài hát',
      confirmLabel: 'Thêm bài hát',
    })) return;
    try {
      await api('/api/admin/songs', json('POST', fields));
      form.reset();
      paginatedLists.songs.page = 1;
      await loadData();
      message('Đã thêm bài hát.');
    } catch (error) {
      message(error.message, true);
    }
  });

  $('#album-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const fields = Object.fromEntries(new FormData(form));
    fields.artistId = Number(fields.artistId);
    fields.year = Number(fields.year);
    if (!await confirmAction(`Thêm album "${fields.title}" vào thư viện?`, {
      title: 'Thêm album',
      confirmLabel: 'Thêm album',
    })) return;
    try {
      await api('/api/admin/albums', json('POST', fields));
      form.reset();
      paginatedLists.albums.page = 1;
      await loadData();
      message('Đã thêm album.');
    } catch (error) {
      message(error.message, true);
    }
  });

  $('#genre-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const fields = Object.fromEntries(new FormData(form));
    if (!await confirmAction(`Thêm thể loại "${fields.name}"?`, {
      title: 'Thêm thể loại',
      confirmLabel: 'Thêm',
    })) return;
    try {
      await api('/api/admin/genres', json('POST', fields));
      form.reset();
      paginatedLists.genres.page = 1;
      await loadData();
      message('Đã thêm thể loại.');
    } catch (error) {
      message(error.message, true);
    }
  });

  document.addEventListener('click', async (event) => {
    const button = event.target.closest('button');
    if (!button) return;
    if (button.dataset.adminSectionTarget) {
      activateAdminSection(button.dataset.adminSectionTarget);
      return;
    }
    if (button.dataset.revenuePeriod) {
      revenuePeriod = button.dataset.revenuePeriod;
      revenueSalesPage = 1;
      renderRevenue();
      return;
    }
    if (button.dataset.revenueSalesPage) {
      revenueSalesPage = Number(button.dataset.revenueSalesPage);
      renderRevenueSales();
      return;
    }
    if (button.dataset.revenuePaymentPage) {
      revenuePaymentsPage = Number(button.dataset.revenuePaymentPage);
      renderRevenuePayments();
      return;
    }
    try {
      if (button.dataset.toggleTrending) {
        const song = data.songs.find((item) => item.id === Number(button.dataset.toggleTrending));
        if (!song) return;
        const isTrending = button.dataset.trendingActive !== 'true';
        if (!await confirmAction(
          isTrending
            ? `Đề cử "${song.title}" lên mục Đang thịnh hành trên trang chủ?`
            : `Bỏ đề cử trend của "${song.title}"?`,
          {
            title: isTrending ? 'Đề cử bài trend' : 'Bỏ đề cử bài trend',
            confirmLabel: isTrending ? 'Đề cử' : 'Bỏ đề cử',
            danger: !isTrending,
          }
        )) return;
        await api(`/api/admin/songs/${song.id}/trending`, json('PATCH', { isTrending }));
        await loadData();
        message(isTrending ? `Đã đề cử "${song.title}" làm trend.` : `Đã bỏ đề cử "${song.title}".`);
      } else if (button.dataset.adminListMore) {
        const key = button.dataset.adminListMore;
        paginatedLists[key].expanded = true;
        paginatedLists[key].page = 1;
        if (key === 'premiumRequests') renderRequestLists();
        else renderCatalogLists();
      } else if (button.dataset.adminListCollapse) {
        const key = button.dataset.adminListCollapse;
        paginatedLists[key].expanded = false;
        paginatedLists[key].page = 1;
        if (key === 'premiumRequests') renderRequestLists();
        else renderCatalogLists();
      } else if (button.dataset.adminListPage) {
        const key = button.dataset.adminListPage;
        const items = key === 'premiumRequests'
          ? data.premiumRequests
          : key === 'songs'
            ? data.songs
            : key === 'albums'
              ? data.albums
              : data.genres;
        const pageCount = Math.ceil(items.length / PAGE_SIZE);
        const page = Number(button.dataset.page);
        if (Number.isInteger(page) && page >= 1 && page <= pageCount) {
          paginatedLists[key].expanded = true;
          paginatedLists[key].page = page;
          if (key === 'premiumRequests') renderRequestLists();
          else renderCatalogLists();
        }
      } else if (button.dataset.supportConversation) {
        selectedSupportId = Number(button.dataset.supportConversation);
        supportMessages = [];
        supportLastMessageId = 0;
        renderSupportList();
        await loadSupportMessages();
      } else if (button.dataset.closeSupportConversation) {
        if (!selectedSupportId || !await confirmAction('Bạn có chắc muốn kết thúc cuộc trò chuyện này không?', {
          title: 'Kết thúc hỗ trợ',
          confirmLabel: 'Kết thúc',
          danger: true,
        })) return;
        await api(`/api/admin/support/conversations/${selectedSupportId}/close`, { method: 'POST' });
        selectedSupportId = null;
        supportMessages = [];
        supportLastMessageId = 0;
        data.supportConversations = await api('/api/admin/support/conversations');
        $('#support-chat-title').textContent = 'Chọn cuộc trò chuyện';
        $('#support-chat-status').textContent = 'Cuộc trò chuyện đã kết thúc.';
        $('#support-reply-input').disabled = true;
        $('#support-reply-input').placeholder = 'Chọn hội thoại trước…';
        $('#support-reply-send').disabled = true;
        $('#support-close-conversation').classList.add('hidden');
        renderSupportList();
        renderSupportMessages();
        message('Đã kết thúc cuộc trò chuyện.');
      } else if (button.dataset.editSong) {
        const song = data.songs.find((item) => item.id === Number(button.dataset.editSong));
        if (!song) return;
        const title = prompt('Tên bài hát:', song.title);
        if (title === null) return;
        const artistName = prompt('Nghệ sĩ:', song.artistName);
        if (artistName === null) return;
        const genre = prompt('Thể loại:', song.genre);
        if (genre === null) return;
        const audioUrl = prompt('URL âm thanh:', song.audioUrl);
        if (audioUrl === null) return;
        const cover = prompt('URL ảnh bìa:', song.cover);
        if (cover === null) return;
        const duration = prompt('Thời lượng (giây):', String(song.duration || 0));
        if (duration === null) return;
        const lyrics = prompt('Lời bài hát:', song.lyrics || '');
        if (lyrics === null) return;
        if (!await confirmAction(`Lưu các thay đổi cho bài hát "${song.title}"?`, {
          title: 'Lưu bài hát',
          confirmLabel: 'Lưu thay đổi',
        })) return;
        await api(`/api/admin/songs/${song.id}`, json('PUT', {
          title, artistName, genre, audioUrl, cover, duration: Number(duration), albumId: song.albumId, lyrics,
        }));
        await loadData();
        message('Đã cập nhật bài hát.');
      } else if (button.dataset.deleteSong) {
        if (!await confirmAction('Bạn có chắc muốn xóa bài hát này không?', {
          title: 'Xóa bài hát',
          confirmLabel: 'Xóa bài hát',
          danger: true,
        })) return;
        await api(`/api/admin/songs/${button.dataset.deleteSong}`, { method: 'DELETE' });
        await loadData();
        message('Đã xóa bài hát.');
      } else if (button.dataset.editAlbum) {
        const album = data.albums.find((item) => item.id === Number(button.dataset.editAlbum));
        if (!album) return;
        const title = prompt('Tên album:', album.title);
        if (title === null) return;
        const year = prompt('Năm phát hành:', String(album.year));
        if (year === null) return;
        const cover = prompt('URL ảnh bìa:', album.cover);
        if (cover === null) return;
        if (!await confirmAction(`Lưu thay đổi cho album "${album.title}"?`, {
          title: 'Lưu album',
          confirmLabel: 'Lưu thay đổi',
        })) return;
        await api(`/api/admin/albums/${album.id}`, json('PUT', {
          title, artistId: album.artistId, year: Number(year), cover,
        }));
        await loadData();
        message('Đã cập nhật album.');
      } else if (button.dataset.deleteAlbum) {
        if (!await confirmAction('Bạn có chắc muốn xóa album không? Các bài hát thuộc album sẽ được chuyển thành chưa có album.', {
          title: 'Xóa album',
          confirmLabel: 'Xóa album',
          danger: true,
        })) return;
        await api(`/api/admin/albums/${button.dataset.deleteAlbum}`, { method: 'DELETE' });
        await loadData();
        message('Đã xóa album.');
      } else if (button.dataset.editGenre !== undefined) {
        const oldName = button.dataset.editGenre;
        const name = prompt('Tên thể loại mới:', oldName);
        if (name === null) return;
        if (!await confirmAction(`Đổi tên thể loại "${oldName}" thành "${name}"?`, {
          title: 'Đổi tên thể loại',
          confirmLabel: 'Đổi tên',
        })) return;
        await api(`/api/admin/genres/${encodeURIComponent(oldName)}`, json('PUT', { name }));
        await loadData();
        message('Đã đổi tên thể loại.');
      } else if (button.dataset.deleteGenre !== undefined) {
        const name = button.dataset.deleteGenre;
        if (!await confirmAction(`Xóa thể loại "${name}"? Các bài hát thuộc thể loại này sẽ chuyển sang thể loại Khác.`, {
          title: 'Xóa thể loại',
          confirmLabel: 'Xóa thể loại',
          danger: true,
        })) return;
        await api(`/api/admin/genres/${encodeURIComponent(name)}`, { method: 'DELETE' });
        await loadData();
        message('Đã xóa thể loại.');
      } else if (button.dataset.saveUser) {
        const id = Number(button.dataset.saveUser);
        const user = data.users.find((item) => item.id === id);
        const role = $(`[data-role="${id}"]`).value;
        const status = $(`[data-status="${id}"]`).value;
        if (!user) return;
        if (
          (role !== user.role || status !== user.status) &&
          !await confirmAction(`Cập nhật vai trò hoặc trạng thái của tài khoản ${user.email}?`, {
            title: 'Cập nhật tài khoản',
            confirmLabel: 'Cập nhật',
          })
        ) return;
        await api(`/api/admin/users/${id}`, json('PATCH', { role, status }));
        await loadData();
        message('Đã cập nhật tài khoản.');
      } else if (button.dataset.togglePremium) {
        const isPremium = button.dataset.premiumActive === 'true';
        const user = data.users.find((item) => item.id === Number(button.dataset.togglePremium));
        if (!user) return;
        if (!await confirmAction(
          isPremium
            ? `Bạn có chắc muốn hủy quyền VIP của ${user.email}?`
            : `Bạn có chắc muốn cấp VIP thêm 1 tháng cho ${user.email}?`,
          {
            title: isPremium ? 'Hủy quyền VIP' : 'Cấp quyền VIP',
            confirmLabel: isPremium ? 'Hủy VIP' : 'Cấp VIP',
            danger: isPremium,
          }
        )) return;
        await api(`/api/admin/users/${button.dataset.togglePremium}/premium`, json('POST', {
          action: isPremium ? 'revoke' : 'grant',
        }));
        await loadData();
        message(isPremium ? 'Đã hủy VIP.' : 'Đã cấp VIP thêm 1 tháng.');
      } else if (button.dataset.resetPassword) {
        const user = data.users.find((item) => item.id === Number(button.dataset.resetPassword));
        if (!user || !await confirmAction(`Tạo liên kết đặt lại mật khẩu cho ${user.email}? Liên kết chỉ dùng một lần và hết hạn sau 30 phút.`, {
          title: 'Tạo liên kết đặt lại mật khẩu',
          confirmLabel: 'Tạo liên kết',
        })) return;
        const result = await api(`/api/admin/users/${user.id}/password-reset`, { method: 'POST' });
        const resetUrl = `${window.location.origin}/#/auth/reset?token=${encodeURIComponent(result.token)}`;
        try {
          await navigator.clipboard.writeText(resetUrl);
          message(`Đã sao chép link đặt lại mật khẩu cho ${user.email}. Hãy gửi riêng cho người dùng; link hết hạn lúc ${new Date(result.expiresAt).toLocaleTimeString('vi-VN')}.`);
        } catch {
          window.prompt(`Sao chép và gửi riêng liên kết này cho ${user.email}:`, resetUrl);
          message(`Đã tạo link đặt lại mật khẩu cho ${user.email}; link hết hạn sau 30 phút.`);
        }
      } else if (button.dataset.reviewPasswordReset) {
        const request = data.passwordResetRequests.find((item) =>
          item.id === Number(button.dataset.reviewPasswordReset)
        );
        if (!request) return;
        const action = button.dataset.reviewAction;
        const promptText = action === 'approve'
          ? `Đã xác minh đây là chủ tài khoản ${request.userEmail} và muốn duyệt yêu cầu?`
          : `Từ chối yêu cầu đặt lại mật khẩu của ${request.userEmail}?`;
        if (!await confirmAction(promptText, {
          title: action === 'approve' ? 'Duyệt yêu cầu đặt lại mật khẩu' : 'Từ chối yêu cầu',
          confirmLabel: action === 'approve' ? 'Duyệt yêu cầu' : 'Từ chối',
          danger: action !== 'approve',
        })) return;
        const result = await api(
          `/api/admin/password-reset-requests/${request.id}/review`,
          json('POST', { action })
        );
        if (action === 'approve') {
          if (result.deliveryMethod === 'email') {
            showPasswordResetResult({
              email: request.userEmail,
              deliveryMethod: 'email',
            });
          } else {
            const resetUrl = `${window.location.origin}/#/auth/reset?token=${encodeURIComponent(result.token)}`;
            showPasswordResetResult({
              email: request.userEmail,
              deliveryMethod: 'admin',
              url: resetUrl,
            });
          }
          await loadData();
        } else {
          await loadData();
          message(`Đã từ chối yêu cầu của ${request.userEmail}.`);
        }
      } else if (button.dataset.reviewPremium) {
        const action = button.dataset.reviewAction;
        const request = data.premiumRequests.find((item) => item.id === Number(button.dataset.reviewPremium));
        if (!request) return;
        if (!await confirmAction(`${action === 'approve' ? 'Duyệt' : 'Từ chối'} yêu cầu VIP của ${request.userName}?`, {
          title: action === 'approve' ? 'Duyệt yêu cầu VIP' : 'Từ chối yêu cầu VIP',
          confirmLabel: action === 'approve' ? 'Duyệt' : 'Từ chối',
          danger: action !== 'approve',
        })) return;
        await api(`/api/admin/premium-requests/${request.id}/review`, json('POST', { action }));
        await loadData();
        message(action === 'approve' ? 'Đã duyệt yêu cầu và kích hoạt VIP.' : 'Đã từ chối yêu cầu VIP.');
      }
    } catch (error) {
      message(error.message, true);
    }
  });

  $('#password-reset-result-close').addEventListener('click', () => $('#password-reset-result').close());
  $('#password-reset-copy').addEventListener('click', async () => {
    const input = $('#password-reset-link');
    try {
      await navigator.clipboard.writeText(input.value);
      $('#password-reset-copy-status').textContent = 'Đã sao chép. Hãy gửi link riêng cho người dùng trước khi hết hạn.';
    } catch {
      input.focus();
      input.select();
      $('#password-reset-copy-status').textContent = 'Không truy cập được clipboard; link đã được chọn để bạn sao chép thủ công.';
    }
  });

  document.addEventListener('change', async (event) => {
    const checkbox = event.target.closest('[data-song-vip]');
    if (!checkbox) return;
    const song = data.songs.find((item) => item.id === Number(checkbox.dataset.songVip));
    if (!song) return;
    const nextIsVip = checkbox.checked;
    if (!await confirmAction(
      nextIsVip
        ? `Đánh dấu "${song.title}" là bài hát VIP?`
        : `Xác nhận bỏ quyền VIP của bài hát "${song.title}"?`,
      {
        title: nextIsVip ? 'Đánh dấu bài VIP' : 'Bỏ quyền VIP bài hát',
        confirmLabel: nextIsVip ? 'Đánh dấu VIP' : 'Bỏ VIP',
        danger: !nextIsVip,
      }
    )) {
      checkbox.checked = !nextIsVip;
      return;
    }
    checkbox.disabled = true;
    try {
      await api(`/api/admin/songs/${checkbox.dataset.songVip}/vip`, json('PATCH', { isVip: nextIsVip }));
      await loadData();
      message(nextIsVip ? 'Đã đánh dấu bài hát VIP.' : 'Đã chuyển bài hát thành thường.');
    } catch (error) {
      checkbox.checked = !nextIsVip;
      checkbox.disabled = false;
      message(error.message, true);
    }
  });

  $('#revenue-sales-period').addEventListener('change', (event) => {
    revenuePeriod = event.currentTarget.value;
    revenueSalesPage = 1;
    renderRevenue();
  });

  $('#overview-listening-period').addEventListener('change', async (event) => {
    listeningPeriod = event.currentTarget.value;
    try {
      data.listening = await api(`/api/admin/listening-analytics?period=${listeningPeriod}`);
      renderOverview();
    } catch (error) {
      message(`Không thể tải thống kê lượt nghe: ${error.message}`, true);
    }
  });

  $('#support-reply-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!selectedSupportId) return;
    const input = $('#support-reply-input');
    const text = input.value.trim();
    if (!text) return;
    $('#support-reply-send').disabled = true;
    try {
      const reply = await api(
        `/api/admin/support/conversations/${selectedSupportId}/messages`,
        json('POST', { message: text })
      );
      supportMessages.push(reply);
      supportLastMessageId = Math.max(supportLastMessageId, reply.id);
      input.value = '';
      await pollSupport();
    } catch (error) {
      message(error.message, true);
    } finally {
      $('#support-reply-send').disabled = false;
      if (selectedSupportId) input.focus();
    }
  });

  $('#admin-logout').addEventListener('click', async () => {
    try {
      await api('/api/auth/logout', { method: 'POST' });
      location.href = '/';
    } catch (error) {
      message(error.message, true);
    }
  });

  async function init() {
    try {
      const result = await api('/api/auth/me');
      if (!result.user) {
        location.href = '/#/auth/login';
        return;
      }
      if (result.user.role !== 'admin') {
        document.body.innerHTML = '<main class="mx-auto max-w-xl p-8 text-white"><h1 class="text-2xl font-bold">Không có quyền truy cập</h1><p class="mt-2 text-gray-400">Trang này chỉ dành cho admin.</p><a class="mt-4 inline-block underline" href="/">Về trang nghe nhạc</a></main>';
        return;
      }
      account = result.user;
      $('#admin-account').textContent = `${account.name} · ${account.email}`;
      await loadData();
      const supportPollTimer = window.setInterval(pollSupport, 2000);
      const requestPollTimer = window.setInterval(pollAdminRequests, 4000);
      const analyticsPollTimer = window.setInterval(pollAdminAnalytics, 15000);
      window.addEventListener('pagehide', () => window.clearInterval(supportPollTimer), { once: true });
      window.addEventListener('pagehide', () => window.clearInterval(requestPollTimer), { once: true });
      window.addEventListener('pagehide', () => window.clearInterval(analyticsPollTimer), { once: true });
      document.addEventListener('visibilitychange', () => {
        if (!document.hidden) {
          pollSupport();
          pollAdminRequests();
          pollAdminAnalytics();
        }
      });
    } catch (error) {
      document.body.innerHTML = `<main class="mx-auto max-w-xl p-8 text-white"><h1 class="text-2xl font-bold">Không tải được trang quản trị</h1><p class="mt-2 text-gray-400">${esc(error.message)}</p><a class="mt-4 inline-block underline" href="/">Về trang nghe nhạc</a></main>`;
    }
  }

  init();
})();
