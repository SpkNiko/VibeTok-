const SUPABASE_URL = 'https://cdqzthqmmffhkoxlbgsn.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_4Nbz7nibH8cFg9dr7sf_Og_UNPphQLO';

const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

let authMode = 'login';
let currentUser = null;
let myProfile = null;
let viewedProfileId = null;
let feedMode = 'foryou';
let soundEnabled = false;
let activeCommentVideoId = null;
let appLoadedForUser = null;

let pendingVideoBlob = null;
let selectedFilter = 'filter-none';
let mediaStream = null;
let mediaRecorder = null;
let recChunks = [];
let pendingAvatarFile = null;

let pendingMfaFactorId = null;
let activeMfaFactorId = null;

const $ = (id) => document.getElementById(id);
const esc = (s = '') => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const safeUrl = (u = '') => (/^https?:\/\//i.test(u.trim()) ? u.trim() : 'https://' + u.trim());

// =======================================================
// START, SESJA I BRAMKA 2FA
// =======================================================
async function init() {
  const { data: { session } } = await sb.auth.getSession();
  await handleSession(session);

  sb.auth.onAuthStateChange(async (_event, session) => {
    await handleSession(session);
  });
}

async function handleSession(session) {
  if (!session) {
    currentUser = null;
    myProfile = null;
    appLoadedForUser = null;
    $('auth-screen').classList.remove('hidden');
    $('mfa-gate-screen').classList.add('hidden');
    $('main-app').classList.add('hidden');
    return;
  }

  currentUser = session.user;
  const { data: aal } = await sb.auth.mfa.getAuthenticatorAssuranceLevel();

  if (aal && aal.currentLevel === 'aal1' && aal.nextLevel === 'aal2') {
    $('auth-screen').classList.add('hidden');
    $('main-app').classList.add('hidden');
    $('mfa-gate-screen').classList.remove('hidden');
    $('mfa-gate-code').value = '';
    $('mfa-gate-error').textContent = '';
    return;
  }

  await enterMainApp();
}

async function enterMainApp() {
  $('auth-screen').classList.add('hidden');
  $('mfa-gate-screen').classList.add('hidden');
  $('main-app').classList.remove('hidden');

  if (appLoadedForUser === currentUser.id) return;
  appLoadedForUser = currentUser.id;

  await loadMyProfile();
  await loadFeed();
}

async function loadMyProfile() {
  let { data } = await sb.from('profiles').select('*').eq('id', currentUser.id).maybeSingle();
  if (!data) {
    const fallbackNick = 'tikyou_' + currentUser.id.slice(0, 5);
    const { data: created } = await sb.from('profiles').upsert({
      id: currentUser.id,
      username: fallbackNick,
      display_name: currentUser.user_metadata?.full_name || fallbackNick
    }).select().single();
    data = created;
  }
  myProfile = data;
}

// =======================================================
// LOGOWANIE, REJESTRACJA, GOOGLE I 2FA GATE
// =======================================================
document.querySelectorAll('.auth-tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.auth-tab').forEach((t) => t.classList.remove('active'));
    tab.classList.add('active');
    authMode = tab.dataset.mode;
    $('auth-username-wrap').classList.toggle('hidden', authMode === 'login');
    $('auth-submit-btn').textContent = authMode === 'login' ? 'Zaloguj się' : 'Utwórz konto';
    $('auth-error').textContent = '';
  });
});

$('auth-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('auth-error').textContent = '';
  const email = $('auth-email').value.trim();
  const password = $('auth-password').value;
  const username = $('auth-username').value.trim();

  if (authMode === 'register') {
    const { data, error } = await sb.auth.signUp({
      email,
      password,
      options: { data: { username: username || email.split('@')[0], full_name: username || 'Twórca' } }
    });
    if (error) return ($('auth-error').textContent = error.message);
    if (!data.session) {
      $('auth-error').textContent = 'Konto utworzone! Sprawdź skrzynkę e-mail i kliknij link potwierdzający.';
    }
  } else {
    const { error } = await sb.auth.signInWithPassword({ email, password });
    if (error) $('auth-error').textContent = 'Błędny e-mail lub hasło.';
  }
});

$('btn-google-login').addEventListener('click', async () => {
  $('auth-error').textContent = '';
  const { error } = await sb.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo: window.location.origin + window.location.pathname }
  });
  if (error) $('auth-error').textContent = error.message;
});

$('btn-mfa-gate-verify').addEventListener('click', async () => {
  const code = $('mfa-gate-code').value.trim();
  $('mfa-gate-error').textContent = '';
  if (code.length !== 6) return ($('mfa-gate-error').textContent = 'Wpisz 6 cyfr z aplikacji.');

  const { data: factors } = await sb.auth.mfa.listFactors();
  const totp = factors?.totp?.find((f) => f.status === 'verified');
  if (!totp) return ($('mfa-gate-error').textContent = 'Nie znaleziono aktywnego 2FA.');

  const { data: chall, error: cErr } = await sb.auth.mfa.challenge({ factorId: totp.id });
  if (cErr) return ($('mfa-gate-error').textContent = cErr.message);

  const { error: vErr } = await sb.auth.mfa.verify({ factorId: totp.id, challengeId: chall.id, code });
  if (vErr) return ($('mfa-gate-error').textContent = 'Nieprawidłowy kod. Spróbuj ponownie.');

  appLoadedForUser = null;
  await enterMainApp();
});

$('btn-mfa-gate-logout').addEventListener('click', () => sb.auth.signOut());
$('btn-logout').addEventListener('click', () => sb.auth.signOut());

// =======================================================
// NAWIGACJA DOLNA
// =======================================================
function switchView(viewId) {
  document.querySelectorAll('.view').forEach((v) => v.classList.remove('active'));
  $(viewId).classList.add('active');
  document.querySelectorAll('.nav-btn').forEach((b) => b.classList.toggle('active', b.dataset.view === viewId));

  if (viewId !== 'feed-view') {
    document.querySelectorAll('#feed-scroll video').forEach((v) => v.pause());
  }
  if (viewId !== 'create-view') stopCameraStream();
}

document.querySelectorAll('.nav-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    const view = btn.dataset.view;
    if (view === 'profile-view') {
      openProfile(currentUser.id, false);
    } else {
      switchView(view);
      if (view === 'feed-view') loadFeed();
    }
  });
});

// =======================================================
// FEED (DLA CIEBIE / OBSERWOWANI)
// =======================================================
document.querySelectorAll('.feed-tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.feed-tab').forEach((t) => t.classList.remove('active'));
    tab.classList.add('active');
    feedMode = tab.dataset.feed;
    loadFeed();
  });
});

$('btn-sound-toggle').addEventListener('click', () => {
  soundEnabled = !soundEnabled;
  $('btn-sound-toggle').textContent = soundEnabled ? '🔊' : '🔇';
  document.querySelectorAll('#feed-scroll video').forEach((v) => (v.muted = !soundEnabled));
});

async function loadFeed() {
  const container = $('feed-scroll');
  container.innerHTML = '<div class="empty-state">Ładowanie filmów...</div>';

  const { data: myFollows } = await sb.from('follows').select('following_id').eq('follower_id', currentUser.id);
  const followingSet = new Set((myFollows || []).map((f) => f.following_id));

  let query = sb.from('videos')
    .select('*, profiles(id, username, display_name, avatar_emoji, avatar_url), video_likes(user_id), comments(id)')
    .order('created_at', { ascending: false })
    .limit(40);

  if (feedMode === 'following') {
    const ids = Array.from(followingSet);
    if (!ids.length) {
      container.innerHTML = '<div class="empty-state"><h3>Nikogo jeszcze nie obserwujesz</h3><p>Przejdź na „Dla Ciebie” i kliknij + pod awatarem twórcy!</p></div>';
      return;
    }
    query = query.in('user_id', ids);
  }

  const { data: videos, error } = await query;
  if (error || !videos?.length) {
    container.innerHTML = '<div class="empty-state"><h3>Brak filmów</h3><p>Kliknij „＋” na dole i wrzuć pierwszego TikYou!</p></div>';
    return;
  }

  container.innerHTML = '';
  videos.forEach((vid) => {
    const author = vid.profiles || {};
    const likes = vid.video_likes || [];
    const isLiked = likes.some((l) => l.user_id === currentUser.id);
    const isFollowing = followingSet.has(vid.user_id);
    const isMe = vid.user_id === currentUser.id;

    const slide = document.createElement('div');
    slide.className = 'video-slide';
    slide.innerHTML = `
      <video class="video-media ${esc(vid.filter_class)}" src="${esc(vid.video_url)}" loop playsinline ${soundEnabled ? '' : 'muted'}></video>
      <div class="video-grad"></div>
      <div class="video-actions">
        <div class="action-avatar-wrap" data-user="${vid.user_id}">
          <div class="action-avatar">${author.avatar_url ? `<img src="${esc(author.avatar_url)}">` : esc(author.avatar_emoji || '😎')}</div>
          ${!isMe && !isFollowing ? `<button class="follow-mini" data-follow="${vid.user_id}">+</button>` : ''}
        </div>
        <button class="action-btn ${isLiked ? 'liked' : ''}" data-like="${vid.id}">
          <span class="icon">♥</span>
          <span class="count">${likes.length}</span>
        </button>
        <button class="action-btn" data-comments="${vid.id}">
          <span class="icon">💬</span>
          <span class="count">${(vid.comments || []).length}</span>
        </button>
      </div>
      <div class="video-info">
        <div class="video-author" data-user="${vid.user_id}">@${esc(author.username || 'tworca')}</div>
        <div class="video-caption">${esc(vid.caption)}</div>
        <div class="video-sound">🎵 ${esc(vid.sound_name)}</div>
      </div>
    `;

    const videoEl = slide.querySelector('video');
    let lastTap = 0;
    videoEl.addEventListener('click', (e) => {
      const now = Date.now();
      if (now - lastTap < 300) {
        spawnHeart(slide, e);
        toggleLike(vid.id, slide.querySelector('[data-like]'), true);
      } else {
        videoEl.paused ? videoEl.play() : videoEl.pause();
      }
      lastTap = now;
    });

    slide.querySelector('[data-like]').addEventListener('click', (e) => toggleLike(vid.id, e.currentTarget, false));
    slide.querySelector('[data-comments]').addEventListener('click', () => openComments(vid.id));
    slide.querySelectorAll('[data-user]').forEach((el) => el.addEventListener('click', () => openProfile(el.dataset.user, true)));
    const followBtn = slide.querySelector('[data-follow]');
    if (followBtn) {
      followBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        await sb.from('follows').insert({ follower_id: currentUser.id, following_id: vid.user_id });
        followBtn.remove();
      });
    }

    container.appendChild(slide);
  });

  setupVideoAutoplay();
}

function setupVideoAutoplay() {
  const observer = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      const v = entry.target.querySelector('video');
      if (!v) return;
      if (entry.isIntersecting) v.play().catch(() => {});
      else v.pause();
    });
  }, { root: $('feed-scroll'), threshold: 0.7 });

  document.querySelectorAll('.video-slide').forEach((s) => observer.observe(s));
}

function spawnHeart(slide, e) {
  const rect = slide.getBoundingClientRect();
  const h = document.createElement('div');
  h.className = 'floating-heart';
  h.textContent = '❤️';
  h.style.left = `${(e.clientX || rect.width / 2) - rect.left}px`;
  h.style.top = `${(e.clientY || rect.height / 2) - rect.top}px`;
  slide.appendChild(h);
  setTimeout(() => h.remove(), 750);
}

async function toggleLike(videoId, btn, onlyAdd) {
  const isLiked = btn.classList.contains('liked');
  const countEl = btn.querySelector('.count');
  let count = parseInt(countEl.textContent, 10) || 0;

  if (isLiked && !onlyAdd) {
    btn.classList.remove('liked');
    countEl.textContent = Math.max(0, count - 1);
    await sb.from('video_likes').delete().eq('video_id', videoId).eq('user_id', currentUser.id);
  } else if (!isLiked) {
    btn.classList.add('liked');
    countEl.textContent = count + 1;
    await sb.from('video_likes').insert({ video_id: videoId, user_id: currentUser.id });
  }
}

// =======================================================
// KOMENTARZE
// =======================================================
async function openComments(videoId) {
  activeCommentVideoId = videoId;
  $('comments-modal').classList.remove('hidden');
  await renderComments();
}

async function renderComments() {
  const list = $('comments-list');
  list.innerHTML = '<p class="muted">Ładowanie...</p>';
  const { data } = await sb.from('comments')
    .select('*, profiles(username)')
    .eq('video_id', activeCommentVideoId)
    .order('created_at', { ascending: true });

  if (!data?.length) {
    list.innerHTML = '<p class="muted" style="text-align:center;margin-top:20px;">Brak komentarzy. Bądź pierwszy!</p>';
    return;
  }
  list.innerHTML = data.map((c) => `
    <div class="comment-item">
      <strong>@${esc(c.profiles?.username || 'user')}</strong>
      <div>${esc(c.text)}</div>
    </div>
  `).join('');
}

$('comment-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = $('comment-input').value.trim();
  if (!text || !activeCommentVideoId) return;
  $('comment-input').value = '';
  await sb.from('comments').insert({ video_id: activeCommentVideoId, user_id: currentUser.id, text });
  await renderComments();
});

// =======================================================
// STUDIO TWORZENIA FILMÓW (+)
// =======================================================
$('video-file-input').addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;
  stopCameraStream();
  pendingVideoBlob = file;
  const pv = $('studio-preview-video');
  pv.srcObject = null;
  pv.src = URL.createObjectURL(file);
  pv.className = selectedFilter;
  pv.classList.remove('hidden');
  $('studio-placeholder').classList.add('hidden');
});

$('btn-record-cam').addEventListener('click', async () => {
  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user' }, audio: true });
    const pv = $('studio-preview-video');
    pv.src = '';
    pv.srcObject = mediaStream;
    pv.className = selectedFilter;
    pv.classList.remove('hidden');
    $('studio-placeholder').classList.add('hidden');

    recChunks = [];
    mediaRecorder = new MediaRecorder(mediaStream);
    mediaRecorder.ondataavailable = (ev) => { if (ev.data.size > 0) recChunks.push(ev.data); };
    mediaRecorder.onstop = () => {
      pendingVideoBlob = new Blob(recChunks, { type: 'video/webm' });
      pv.srcObject = null;
      pv.src = URL.createObjectURL(pendingVideoBlob);
      stopCameraStream();
    };
    mediaRecorder.start();
    $('rec-badge').classList.remove('hidden');
    $('btn-stop-rec').classList.remove('hidden');
  } catch {
    $('upload-status').textContent = 'Brak dostępu do kamerki lub strona nie działa przez HTTPS.';
  }
});

$('btn-stop-rec').addEventListener('click', () => {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') mediaRecorder.stop();
  $('rec-badge').classList.add('hidden');
  $('btn-stop-rec').classList.add('hidden');
});

function stopCameraStream() {
  if (mediaStream) {
    mediaStream.getTracks().forEach((t) => t.stop());
    mediaStream = null;
  }
}

document.querySelectorAll('.filter-pill').forEach((pill) => {
  pill.addEventListener('click', () => {
    document.querySelectorAll('.filter-pill').forEach((p) => p.classList.remove('active'));
    pill.classList.add('active');
    selectedFilter = pill.dataset.filter;
    if (!$('studio-preview-video').classList.contains('hidden')) {
      $('studio-preview-video').className = selectedFilter;
    }
  });
});

$('btn-publish-video').addEventListener('click', async () => {
  $('upload-status').textContent = '';
  if (!pendingVideoBlob) return ($('upload-status').textContent = 'Najpierw wybierz lub nagraj film!');

  const btn = $('btn-publish-video');
  btn.disabled = true;
  btn.textContent = 'Wysyłanie do chmury...';

  const ext = pendingVideoBlob.type.includes('mp4') ? 'mp4' : 'webm';
  const filePath = `${currentUser.id}/${Date.now()}.${ext}`;

  const { error: upErr } = await sb.storage.from('videos').upload(filePath, pendingVideoBlob);
  if (upErr) {
    $('upload-status').textContent = 'Błąd wgrywania: ' + upErr.message;
    btn.disabled = false;
    btn.textContent = '🚀 Opublikuj na TikYou';
    return;
  }

  const { data: pub } = sb.storage.from('videos').getPublicUrl(filePath);
  const { error: dbErr } = await sb.from('videos').insert({
    user_id: currentUser.id,
    video_url: pub.publicUrl,
    caption: $('video-caption').value.trim(),
    sound_name: $('video-sound').value.trim() || 'Oryginalny dźwięk',
    filter_class: selectedFilter
  });

  btn.disabled = false;
  btn.textContent = '🚀 Opublikuj na TikYou';
  if (dbErr) return ($('upload-status').textContent = dbErr.message);

  pendingVideoBlob = null;
  $('studio-preview-video').classList.add('hidden');
  $('studio-placeholder').classList.remove('hidden');
  $('video-caption').value = '';
  $('video-sound').value = '';
  switchView('feed-view');
  await loadFeed();
});

// =======================================================
// PROFIL + CUSTOMIZACJA + 5 WIDŻETÓW
// =======================================================
async function openProfile(userId, showBack) {
  viewedProfileId = userId;
  switchView('profile-view');
  const isMe = userId === currentUser.id;

  $('btn-profile-back').classList.toggle('hidden', !showBack);
  $('btn-open-customizer').classList.toggle('hidden', !isMe);
  $('btn-open-2fa').classList.toggle('hidden', !isMe);
  $('btn-logout').classList.toggle('hidden', !isMe);

  const [{ data: profile }, { data: videos }, { data: followers }, { data: following }] = await Promise.all([
    sb.from('profiles').select('*').eq('id', userId).single(),
    sb.from('videos').select('*, video_likes(user_id)').eq('user_id', userId).order('created_at', { ascending: false }),
    sb.from('follows').select('follower_id').eq('following_id', userId),
    sb.from('follows').select('following_id').eq('follower_id', userId)
  ]);

  if (!profile) return;
  if (isMe) myProfile = profile;

  const pv = $('profile-view');
  pv.className = `view active ${profile.theme || 'theme-cyberpunk'}`;
  $('profile-bg-fx').className = `profile-bg-fx ${profile.bg_fx || ''}`;
  $('profile-avatar-frame').className = `avatar-frame ${profile.avatar_frame || 'frame-rgb'}`;
  $('profile-avatar-inner').innerHTML = profile.avatar_url ? `<img src="${esc(profile.avatar_url)}">` : esc(profile.avatar_emoji || '😎');

  const nameEl = $('profile-display-name');
  nameEl.textContent = profile.display_name;
  nameEl.style.fontFamily = `'${profile.font_style || 'Inter'}', sans-serif`;

  $('profile-username').textContent = `@${profile.username}`;
  $('profile-bio').textContent = profile.bio || 'Brak opisu.';
  $('profile-badges').innerHTML = (profile.badges || []).map((b) => `<span class="badge-pill">${esc(b)}</span>`).join('');

  const followerCount = (followers || []).length;
  const totalLikes = (videos || []).reduce((sum, v) => sum + (v.video_likes?.length || 0), 0);
  $('stat-following').textContent = (following || []).length;
  $('stat-followers').textContent = followerCount;
  $('stat-likes').textContent = totalLikes;

  const followBtn = $('btn-profile-follow');
  if (isMe) {
    followBtn.classList.add('hidden');
  } else {
    followBtn.classList.remove('hidden');
    const amFollowing = (followers || []).some((f) => f.follower_id === currentUser.id);
 
