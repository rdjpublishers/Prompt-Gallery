/* =========================================================================
   admin.js — Prompt Gallery admin panel (separate from index.html)

   - All admin state, modal markup, and admin-only functions live here.
   - The admin modal (`#admin-mw`) and edit modal (`#edit-mw`) are NOT
     present in the static HTML; they are built and injected by this file
     ONLY after the owner unlocks the panel with the correct password.
   - Trigger: triple-click the green dot at the top-right
     (`<div id="adminDot" onclick="openAdminEntry()">`).
   - All functions here are exposed as globals so the inline `onclick`
     handlers inside the dynamically-injected modals can call them.

   Cross-script contract: this file assumes the host page (`index.html`)
   has already defined the following globals (declared with `var` so they
   land on `window`):
     DATA, FAVS, CAT, SORT, QUERY, CURRENT_LB,
     GH, SK, FK, GK,
     ea, esc, uid,
     save, saveGH,
     renderGallery, renderSidebar, renderCatTabs, renderFavs.

   Admin-only state below is declared with `var` for the same reason — so
   `index.html`'s `init()` can reset `ADMIN_AUTH` to false on every load.
   ========================================================================= */

/* ---------- admin password — stored as SHA-256 hash (not plain text) ---------- */
var ADMIN_HASH = '26f5f8b67b8a8cf17b2a2e43dc2dea57bfdd1cf27175260280308e356ea8e99d';
async function checkPassword(input){
  const enc = new TextEncoder().encode(input);
  const buf = await crypto.subtle.digest('SHA-256', enc);
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2,'0')).join('');
}

/* ---------- admin-only state (globals via `var`) ---------- */
var ADMIN_AUTH          = false;
var ADMIN_TAB           = 'list';
var ADMIN_AUTH_KEY      = 'pg_admin_unlocked';
var F                   = { title:'', category:'', imageUrl:'', prompt:'', tags:'' };
var F_ERR               = '';
var F_OK                = false;
var PENDING_IMG_FILE    = null;
var PENDING_IMGS        = [];
var DOT_CLICKS          = 0;
var DOT_TIMER           = null;
var GH_STS              = '';
var GH_MSG              = '';
var GH_PROGRESS         = '';
var EDITING_CAT         = null;
var EDITING_ID          = null;
var EDIT_IMGS           = [];

/* ---------- modal injection (admin + edit) ---------- */

function openAdminEntry(){
  DOT_CLICKS++;
  clearTimeout(DOT_TIMER);
  if (DOT_CLICKS >= 3) {
    DOT_CLICKS = 0;
    openAdmin();
  } else {
    DOT_TIMER = setTimeout(function(){ DOT_CLICKS = 0; }, 650);
  }
}

function buildAdminModal(){
  // Returns the full admin modal markup. No admin text/buttons exist in
  // the page until this is invoked and the resulting element is appended
  // to <body>.
  return '<div class="mw show" id="admin-mw"><div class="am"><div class="am-hd"><h2>⚙ Admin Panel</h2>'
    + '<div style="display:flex;gap:6px">'
    +   '<button id="adminSignOutBtn" onclick="signOutAdmin()" title="Sign out and lock the admin panel">⏻ Sign Out</button>'
    +   '<button onclick="closeAdmin()" title="Close">✕</button>'
    + '</div></div>'
    + '<div id="am-content" style="display:flex;flex-direction:column;flex:1;overflow:hidden;"></div>'
    + '</div></div>';
}

function openAdmin(){
  // If the modal doesn't exist in the DOM, inject it now. This is the
  // ONLY place admin elements ever enter the page.
  let mw = document.getElementById('admin-mw');
  if (!mw) {
    const wrap = document.createElement('div');
    wrap.innerHTML = buildAdminModal();
    document.body.appendChild(wrap.firstElementChild);
    mw = document.getElementById('admin-mw');
  }
  mw.classList.add('show');
  document.body.style.overflow = 'hidden';
  ADMIN_TAB = 'list';
  F_ERR = ''; F_OK = false; GH_STS = '';
  renderAdminContent();
  // Remember unlock across refreshes so the owner doesn't have to
  // re-enter the password on every reload. Sign-out clears this flag.
  try { localStorage.setItem(ADMIN_AUTH_KEY, '1'); } catch (e) {}
}

function closeAdmin(){
  // Hide the modal and reset auth for this session, but keep the element
  // around if the user is still "remembered as unlocked" so reopening is
  // instant. A full sign-out (signOutAdmin) removes the element from DOM.
  const mw = document.getElementById('admin-mw');
  if (mw) mw.classList.remove('show');
  document.body.style.overflow = '';
  ADMIN_AUTH = false;
}

function signOutAdmin(){
  // Lock the admin panel, remove the injected modal from the DOM, and
  // forget the unlocked state so a refresh keeps it locked.
  const mw  = document.getElementById('admin-mw');
  if (mw)  mw.remove();
  const emw = document.getElementById('edit-mw');
  if (emw) emw.remove();
  document.body.style.overflow = '';
  ADMIN_AUTH = false;
  EDITING_ID = null;
  EDIT_IMGS  = [];
  try { localStorage.removeItem(ADMIN_AUTH_KEY); } catch (e) {}
}

function restoreAdminIfUnlocked(){
  // Called once on init (from index.html's init()). If the owner previously
  // unlocked the panel in this browser, build the modal and show it
  // (already-authenticated state) so a refresh keeps it open.
  try {
    if (localStorage.getItem(ADMIN_AUTH_KEY) === '1') {
      ADMIN_AUTH = true;
      let mw = document.getElementById('admin-mw');
      if (!mw) {
        const wrap = document.createElement('div');
        wrap.innerHTML = buildAdminModal();
        document.body.appendChild(wrap.firstElementChild);
        mw = document.getElementById('admin-mw');
      }
      mw.classList.add('show');
      document.body.style.overflow = 'hidden';
      renderAdminContent();
    }
  } catch (e) {}
}

function ensureEditModal(){
  // Edit modal is also admin-only — inject it on first use so it never
  // appears in the static HTML source.
  let mw = document.getElementById('edit-mw');
  if (!mw) {
    const wrap = document.createElement('div');
    wrap.innerHTML =
      '<div class="mw" id="edit-mw">'
      + '<div class="am edit-mw" style="max-width: 700px;">'
      +   '<div class="am-hd"><h2>✏️ Edit Prompt</h2>'
      +     '<button onclick="closeEditModal()" title="Close">✕</button>'
      +   '</div>'
      +   '<div class="am-body" id="edit-body" style="overflow-y: auto; max-height: 70vh;"></div>'
      + '</div></div>';
    document.body.appendChild(wrap.firstElementChild);
    mw = document.getElementById('edit-mw');
  }
  return mw;
}

function openEditModal(id){
  // Guard: only the admin can edit prompts. If somehow triggered without
  // auth, bounce.
  if (!ADMIN_AUTH) return;
  const prompt = DATA.prompts.find(function(p){ return p.id === id; });
  if (!prompt) return;
  EDITING_ID = id;
  const existingImgs = (prompt.images && prompt.images.length)
    ? prompt.images
    : [prompt.imageUrl];
  EDIT_IMGS = existingImgs.map(function(url){
    if (url && url.startsWith('data:')) return { dataUrl: url, url: url };
    return { url: url };
  });
  // Inject the modal first (so #edit-body exists), then fill it.
  ensureEditModal();
  renderEditForm(prompt);
  document.getElementById('edit-mw').classList.add('show');
  document.body.style.overflow = 'hidden';
}

function closeEditModal(){
  const mw = document.getElementById('edit-mw');
  if (mw) mw.classList.remove('show');
  document.body.style.overflow = '';
  EDITING_ID = null;
  EDIT_IMGS  = [];
}

function renderEditForm(prompt){
  const catOptions = DATA.categories
    .map(function(c){
      return '<option value="'+ea(c)+'" '+(prompt.category === c ? 'selected' : '')+'>'+esc(c)+'</option>';
    })
    .join('');
  const tagsValue = (prompt.tags || []).join(', ');
  const listHtml = EDIT_IMGS.map(function(img, i){
    const thumb  = img.dataUrl || img.url || '';
    const label  = img.file ? img.file.name : (img.url || 'URL image');
    const status = (img.dataUrl && img.dataUrl.startsWith('data:'))
      ? '💾 local (uploads on push)'
      : ((img.url && !img.url.startsWith('data:')) ? '✓ saved' : '🔗 URL');
    return '<div class="mi-item">'
      + '<img class="mi-thumb" src="'+esc(thumb)+'" onerror="this.src=\'https://picsum.photos/seed/edit'+i+'/60/60\'">'
      + '<span class="mi-url">'+esc(label)+'</span>'
      + '<span class="mi-status">'+status+'</span>'
      + '<button class="mi-del" onclick="editRemoveImage('+i+')">✕</button>'
      + '</div>';
  }).join('');
  const html =
      '<div><label class="afl">Title *</label>'
      + '<input class="afi" id="edit-title" type="text" value="'+ea(prompt.title)+'"></div>'
      + '<div><label class="afl">Category *</label>'
      + '<select class="afsel" id="edit-cat">'+catOptions+'</select></div>'
      + '<div><div class="mi-lbl"><label class="afl">Images (first = cover)</label>'
      + '<span>'+EDIT_IMGS.length+' added</span></div>'
      + '<div class="mi-list" id="edit-mi-list">'
      + (listHtml || '<div style="font-size:11px;color:var(--muted);padding:4px 0">No images</div>')
      + '</div>'
      + '<label class="mi-drop" id="edit-drop-label">'
      +   '<span>🖼 Click or drag to upload image</span>'
      +   '<input type="file" id="edit-file-in" accept="image/*" multiple '
      +     'onchange="editAddFiles(this.files); this.value=\'\'">'
      + '</label>'
      + '<div class="mi-add-row">'
      +   '<input class="afi" id="edit-url-in" type="url" placeholder="Or paste image URL and press ＋">'
      +   '<button class="bg" style="padding:7px 11px" onclick="editAddUrl()">＋</button>'
      + '</div></div>'
      + '<div><label class="afl">Prompt *</label>'
      + '<textarea class="afta" id="edit-prompt" rows="3">'+esc(prompt.prompt)+'</textarea></div>'
      + '<div><label class="afl">Tags (comma-separated)</label>'
      + '<input class="afi" id="edit-tags" type="text" value="'+ea(tagsValue)+'"></div>'
      + '<div id="edit-err" class="ntc err" style="display:none"></div>'
      + '<button class="bg" style="width:100%;justify-content:center" onclick="saveEditPrompt()">💾 Save Changes</button>';
  document.getElementById('edit-body').innerHTML = html;
  const dropZone = document.getElementById('edit-drop-label');
  if (dropZone) {
    dropZone.addEventListener('dragover',  function(e){ e.preventDefault(); dropZone.style.borderColor = 'var(--gold)'; });
    dropZone.addEventListener('dragleave',  function(){  dropZone.style.borderColor = ''; });
    dropZone.addEventListener('drop',       function(e){ e.preventDefault(); if (e.dataTransfer.files.length) editAddFiles(e.dataTransfer.files); });
  }
}

function editRemoveImage(idx){
  EDIT_IMGS.splice(idx, 1);
  renderEditForm(DATA.prompts.find(function(p){ return p.id === EDITING_ID; }));
}

function editAddUrl(){
  const inp = document.getElementById('edit-url-in');
  const url = inp.value.trim();
  if (!url) return;
  EDIT_IMGS.push({ url: url });
  inp.value = '';
  renderEditForm(DATA.prompts.find(function(p){ return p.id === EDITING_ID; }));
}

function editAddFiles(files){
  Array.from(files).forEach(function(file){
    const reader = new FileReader();
    reader.onload = function(e){
      EDIT_IMGS.push({ file: file, dataUrl: e.target.result });
      renderEditForm(DATA.prompts.find(function(p){ return p.id === EDITING_ID; }));
    };
    reader.readAsDataURL(file);
  });
}

function saveEditPrompt(){
  const title     = document.getElementById('edit-title').value.trim();
  const category  = document.getElementById('edit-cat').value;
  const promptTxt = document.getElementById('edit-prompt').value.trim();
  const tagsRaw   = document.getElementById('edit-tags').value;
  const tags      = tagsRaw.split(',').map(function(t){ return t.trim(); }).filter(Boolean);
  const errDiv    = document.getElementById('edit-err');
  errDiv.style.display = 'none';
  if (!title || !category || !promptTxt) {
    errDiv.textContent = 'Title, category and prompt are required.';
    errDiv.style.display = 'block';
    return;
  }
  // Save data URLs or plain URLs directly — no GitHub upload at edit time.
  const finalImages = EDIT_IMGS
    .map(function(img){ return img.dataUrl || img.url; })
    .filter(Boolean);
  const cover = finalImages[0] || ('https://picsum.photos/seed/' + EDITING_ID + '/600/750');
  const index = DATA.prompts.findIndex(function(p){ return p.id === EDITING_ID; });
  if (index !== -1) {
    DATA.prompts[index] = Object.assign({}, DATA.prompts[index], {
      title: title,
      category: category,
      imageUrl: cover,
      images: finalImages,
      prompt: promptTxt,
      tags: tags
    });
    save();
    if (document.getElementById('page-gallery').classList.contains('active')) renderGallery();
    if (document.getElementById('page-favs').classList.contains('active')) renderFavs();
    if (ADMIN_AUTH && ADMIN_TAB === 'list') renderAdminContent();
    closeEditModal();
  } else {
    errDiv.textContent = 'Prompt not found.';
    errDiv.style.display = 'block';
  }
}

/* ---------- admin content rendering ---------- */

function renderAdminContent(){
  const el = document.getElementById('am-content');
  if (!ADMIN_AUTH) {
    el.innerHTML = renderLockScreen();
    return;
  }
  const tabsHtml = ['list','add','cats','github'].map(function(t){
    const label = ({list:'Prompts',add:'Add New',cats:'Categories',github:'GitHub Sync'})[t];
    return '<button class="amt '+(ADMIN_TAB===t?'active':'')+'" onclick="switchTab(\''+t+'\')">'+label+'</button>';
  }).join('');
  el.innerHTML = '<div class="am-tabs">'+tabsHtml+'</div>'
    + '<div class="am-body" id="am-body">'+renderAdminTab()+'</div>';

  // Wire up drag-and-drop on the image upload zone (only when present).
  const dropZone = document.getElementById('mi-drop-label');
  if (dropZone) {
    dropZone.addEventListener('dragover', function(e){
      e.preventDefault();
      dropZone.style.borderColor = 'var(--gold)';
      dropZone.style.color       = 'var(--gold)';
    });
    dropZone.addEventListener('dragleave', function(){
      dropZone.style.borderColor = '';
      dropZone.style.color       = '';
    });
    dropZone.addEventListener('drop', function(e){
      e.preventDefault();
      dropZone.style.borderColor = '';
      dropZone.style.color       = '';
      if (e.dataTransfer.files.length) miAddFiles(e.dataTransfer.files);
    });
  }
}

function renderLockScreen(){
  return '<div class="al">'
    + '<div class="ali">🔐</div>'
    + '<h3>Admin Access</h3>'
    + '<p>Enter the admin password to continue</p>'
    + '<input class="al-in" type="password" id="al-pw" placeholder="••••••••" '
    +   'onkeydown="if(event.key===\'Enter\')checkPass()">'
    + '<div class="al-err" id="al-err" style="display:none">Incorrect password. Try again.</div>'
    + '<div class="brow" style="justify-content:center;gap:10px">'
    +   '<button class="bg" onclick="checkPass()">🔓 Unlock</button>'
    +   '<button class="bs" onclick="closeAdmin()">Cancel</button>'
    + '</div></div>';
}

async function checkPass(){
  const v = document.getElementById('al-pw').value;
  const hash = await checkPassword(v);
  if (hash === ADMIN_HASH) {
    ADMIN_AUTH = true;
    renderAdminContent();
  } else {
    document.getElementById('al-err').style.display = 'block';
  }
}

function switchTab(t){
  ADMIN_TAB = t;
  F_ERR = ''; F_OK = false; GH_STS = ''; GH_PROGRESS = '';
  if (t === 'add') {
    F = { title:'', category:'', imageUrl:'', prompt:'', tags:'' };
    PENDING_IMG_FILE = null;
    PENDING_IMGS = [];
  }
  renderAdminContent();
}

function renderAdminTab(){
  if (ADMIN_TAB === 'list')   return renderPromptList();
  if (ADMIN_TAB === 'add')    return renderAddForm();
  if (ADMIN_TAB === 'cats')   return renderCatManager();
  if (ADMIN_TAB === 'github') return renderGitHub();
  return '';
}

/* ---------- Prompts tab ---------- */

function renderPromptList(){
  if (!DATA.prompts.length) {
    return '<div style="text-align:center;color:var(--muted);padding:40px 0">No prompts yet. Add some using the "Add New" tab!</div>';
  }
  return '<div class="apl">' + DATA.prompts.map(function(p){
    return '<div class="apl-i">'
      + '<img class="apl-t" src="'+esc(p.imageUrl)+'" onerror="this.src=\'https://picsum.photos/seed/'+p.id+'/600/750\'">'
      + '<div class="apl-inf">'
      +   '<div class="apl-n">'+esc(p.title)+'</div>'
      +   '<div class="apl-c">'+esc(p.category)+'</div>'
      + '</div>'
      + '<div style="display:flex; gap:5px;">'
      +   '<button class="bs" style="padding:5px 9px; font-size:12px;" onclick="openEditModal(\''+p.id+'\')">✏️</button>'
      +   '<button class="bd" onclick="delPrompt(\''+p.id+'\')">🗑</button>'
      + '</div>'
      + '</div>';
  }).join('') + '</div>';
}

function delPrompt(id){
  if (!confirm('Delete this prompt? This cannot be undone.')) return;
  DATA.prompts = DATA.prompts.filter(function(p){ return p.id !== id; });
  save();
  renderGallery();
  renderAdminContent();
}

/* ---------- Add New tab ---------- */

function renderAddForm(){
  const catOpts = DATA.categories.map(function(c){
    return '<option value="'+ea(c)+'" '+(F.category===c?'selected':'')+'>'+esc(c)+'</option>';
  }).join('');
  const listHtml = PENDING_IMGS.length
    ? PENDING_IMGS.map(function(img, i){
        const thumb  = img.dataUrl || img.url || '';
        const label  = img.file ? img.file.name : (img.url || 'URL');
        const status = (img.dataUrl && img.dataUrl.startsWith('data:')) ? '💾 local (uploads on push)' : '🔗 URL';
        return '<div class="mi-item">'
          + '<img class="mi-thumb" src="'+esc(thumb)+'" onerror="this.src=\'https://picsum.photos/seed/mi'+i+'/60/60\'">'
          + '<span class="mi-url">'+esc(label)+'</span>'
          + '<span class="mi-status">'+status+'</span>'
          + '<button class="mi-del" onclick="miRemove('+i+')" title="Remove">✕</button>'
          + '</div>';
      }).join('')
    : '<div style="font-size:11px;color:var(--muted);padding:4px 0">Upload files or paste URLs below.</div>';
  return '<div><label class="afl">Title *</label>'
    + '<input class="afi" id="f-title" type="text" value="'+ea(F.title)+'" oninput="F.title=this.value"></div>'
    + '<div><label class="afl">Category *</label>'
    + '<select class="afsel" id="f-cat" onchange="F.category=this.value"><option value="">Select category…</option>'+catOpts+'</select></div>'
    + '<div><div class="mi-lbl"><label class="afl" style="margin:0">Images <span style="font-weight:400;opacity:.6">(first = cover photo)</span></label>'
    +   '<span>'+PENDING_IMGS.length+' added</span></div>'
    + '<div class="mi-list" id="mi-list">'+listHtml+'</div>'
    + '<label class="mi-drop" id="mi-drop-label">'
    +   '<span>🖼 Click or drag to upload image</span>'
    +   '<input type="file" id="mi-file-in" accept="image/*" multiple onchange="miAddFiles(this.files);this.value=\'\'">'
    + '</label>'
    + '<div class="mi-add-row">'
    +   '<input class="afi" id="mi-url-in" type="url" placeholder="Or paste image URL and press ＋">'
    +   '<button class="bg" style="padding:7px 11px" onclick="miAddUrl()">＋</button>'
    + '</div></div>'
    + '<div><label class="afl">Prompt *</label>'
    + '<textarea class="afta" id="f-prompt" oninput="F.prompt=this.value">'+esc(F.prompt)+'</textarea></div>'
    + '<div><label class="afl">Tags (comma-separated)</label>'
    + '<input class="afi" id="f-tags" type="text" value="'+ea(F.tags)+'" oninput="F.tags=this.value"></div>'
    + (F_ERR ? '<div class="ntc err">'+esc(F_ERR)+'</div>' : '')
    + (F_OK  ? '<div class="ntc ok">✓ Prompt saved locally! Use GitHub Sync to publish.</div>' : '')
    + '<button class="bg" style="width:100%;justify-content:center" onclick="addPrompt()">＋ Add Prompt</button>';
}

function updateImgPreview(){
  const el = document.getElementById('f-prev');
  const ph = document.getElementById('f-ph');
  if (el) el.src = F.imageUrl;
  else if (F.imageUrl && ph) {
    ph.outerHTML = '<img class="ipv" id="f-prev" src="'+esc(F.imageUrl)+'" onerror="this.style.display=\'none\'">';
  }
}

function onFileChange(input){
  const file = input.files[0];
  if (!file) return;
  PENDING_IMG_FILE = file;
  const reader = new FileReader();
  reader.onload = function(e){
    const ph = document.getElementById('f-ph');
    if (ph) ph.outerHTML = '<img class="ipv" id="f-prev" src="'+e.target.result+'" alt="preview">';
  };
  reader.readAsDataURL(file);
}

function miRenderList(){
  const list = document.getElementById('mi-list');
  if (!list) return;
  if (!PENDING_IMGS.length) {
    list.innerHTML = '<div style="font-size:11px;color:var(--muted);padding:4px 0">No images added yet. Upload files or paste URLs below.</div>';
    return;
  }
  list.innerHTML = PENDING_IMGS.map(function(img, i){
    const thumb  = img.dataUrl || img.url || '';
    const label  = img.file ? img.file.name : (img.url || 'URL image');
    const status = (img.dataUrl && img.dataUrl.startsWith('data:')) ? '💾 local (uploads on push)' : '🔗 URL';
    return '<div class="mi-item">'
      + '<img class="mi-thumb" src="'+esc(thumb)+'" onerror="this.src=\'https://picsum.photos/seed/mi'+i+'/60/60\'">'
      + '<span class="mi-url">'+esc(label)+'</span>'
      + '<span class="mi-status">'+status+'</span>'
      + '<button class="mi-del" onclick="miRemove('+i+')" title="Remove">✕</button>'
      + '</div>';
  }).join('');
}

function miRemove(i){
  PENDING_IMGS.splice(i, 1);
  miRenderList();
}

function miUpdateTokRow(){
  // no-op: token row removed from add form
}

function miAddUrl(){
  const inp = document.getElementById('mi-url-in');
  if (!inp) return;
  const url = inp.value.trim();
  if (!url) return;
  PENDING_IMGS.push({ url: url });
  inp.value = '';
  miRenderList();
}

function miAddFiles(files){
  Array.from(files).forEach(function(file){
    const reader = new FileReader();
    reader.onload = function(e){
      PENDING_IMGS.push({ file: file, dataUrl: e.target.result });
      miRenderList();
    };
    reader.readAsDataURL(file);
  });
}

function addPrompt(){
  const fTitleEl = document.getElementById('f-title');
  const fCatEl   = document.getElementById('f-cat');
  const fProEl   = document.getElementById('f-prompt');
  const fTagEl   = document.getElementById('f-tags');
  F.title    = (fTitleEl ? fTitleEl.value : F.title)    || F.title;
  F.category = (fCatEl   ? fCatEl.value   : F.category) || F.category;
  F.prompt   = (fProEl   ? fProEl.value   : F.prompt)   || F.prompt;
  F.tags     = (fTagEl   ? fTagEl.value   : F.tags)     || F.tags;

  if (!F.title.trim())   { F_ERR = 'Title is required.';     renderAdminContent(); return; }
  if (!F.category)       { F_ERR = 'Please select a category.'; renderAdminContent(); return; }
  if (!F.prompt.trim())  { F_ERR = 'Prompt text is required.';  renderAdminContent(); return; }

  // Save data URLs (files) or plain URLs directly — no GitHub upload at
  // this stage.
  const allImgs = PENDING_IMGS
    .map(function(img){ return img.dataUrl || img.url; })
    .filter(Boolean);
  const primaryUrl = allImgs[0] || ('https://picsum.photos/seed/'+uid()+'/600/750');
  const tags = F.tags ? F.tags.split(',').map(function(t){ return t.trim(); }).filter(Boolean) : [];
  DATA.prompts.unshift({
    id: uid(),
    title: F.title.trim(),
    category: F.category,
    imageUrl: primaryUrl,
    images: allImgs.length ? allImgs : [primaryUrl],
    prompt: F.prompt.trim(),
    tags: tags,
    createdAt: new Date().toISOString().split('T')[0],
    copyCount: 0
  });
  save();
  F = { title:'', category:'', imageUrl:'', prompt:'', tags:'' };
  PENDING_IMG_FILE = null;
  PENDING_IMGS = [];
  F_ERR = '';
  F_OK  = true;
  renderGallery();
  renderAdminContent();
  setTimeout(function(){ F_OK = false; }, 3000);
}

/* ---------- Categories tab ---------- */

function renderCatManager(){
  const list = DATA.categories.map(function(c){
    if (EDITING_CAT === c) {
      return '<div class="acl-i" style="flex-wrap:wrap;gap:6px">'
        + '<input class="afi" id="ec-emoji" value="'+ea(DATA.categoryEmojis[c]||'🏷')+'" style="width:52px;text-align:center;font-size:18px;padding:4px 6px" placeholder="🏷" title="Emoji">'
        + '<input class="afi" id="ec-in" value="'+ea(c)+'" style="flex:1" placeholder="Category name">'
        + '<div class="acl-b">'
        +   '<button class="bg" style="padding:5px 10px" onclick="saveEditCat(\''+ea(c)+'\')">Save</button>'
        +   '<button class="bs" style="padding:5px 10px" onclick="EDITING_CAT=null;renderAdminContent()">✕</button>'
        + '</div></div>';
    }
    return '<div class="acl-i">'
      + '<span style="font-size:16px;width:24px;text-align:center;flex-shrink:0">'+esc(DATA.categoryEmojis[c]||'🏷')+'</span>'
      + '<span class="acl-n">'+esc(c)+'</span>'
      + '<div class="acl-b">'
      +   '<button class="bs" style="padding:5px 9px;font-size:12px" onclick="EDITING_CAT=\''+ea(c)+'\';renderAdminContent()">✏️</button>'
      +   '<button class="bd" onclick="deleteCat(\''+ea(c)+'\')">🗑</button>'
      + '</div></div>';
  }).join('');
  return '<div class="acl">'+list+'</div>'
    + '<div style="border-top:1px solid var(--border);padding-top:14px;margin-top:4px">'
    +   '<label class="afl" style="margin-bottom:6px">Add New Category</label>'
    +   '<div style="display:flex;gap:8px">'
    +     '<input class="afi" id="nc-emoji" type="text" placeholder="🏷" style="width:52px;text-align:center;font-size:18px;padding:4px 6px" title="Emoji for this category">'
    +     '<input class="afi" id="nc-in" type="text" placeholder="Category name" style="flex:1">'
    +     '<button class="bg" onclick="addCat()">＋</button>'
    +   '</div>'
    +   '<div style="font-size:11px;color:var(--muted);margin-top:5px">Paste or type any emoji in the first box, then enter the category name.</div>'
    + '</div>';
}

function addCat(){
  const v     = (document.getElementById('nc-in')    || {}).value ? document.getElementById('nc-in').value.trim()    : '';
  const emoji = (document.getElementById('nc-emoji') || {}).value ? document.getElementById('nc-emoji').value.trim() : '🏷';
  if (!v) return;
  if (DATA.categories.indexOf(v) !== -1) {
    alert('Category already exists.');
    return;
  }
  DATA.categories.push(v);
  if (!DATA.categoryEmojis) DATA.categoryEmojis = {};
  DATA.categoryEmojis[v] = emoji;
  save();
  renderCatTabs();
  renderSidebar();
  renderAdminContent();
}

function deleteCat(name){
  const count = DATA.prompts.filter(function(p){ return p.category === name; }).length;
  if (!confirm('Delete "'+name+'"?'+(count ? ' '+count+' prompt(s) use this category.' : ''))) return;
  DATA.categories = DATA.categories.filter(function(c){ return c !== name; });
  if (DATA.categoryEmojis) delete DATA.categoryEmojis[name];
  save();
  renderCatTabs();
  renderSidebar();
  renderAdminContent();
}

function saveEditCat(old){
  const inEl     = document.getElementById('ec-in');
  const emojiEl  = document.getElementById('ec-emoji');
  const newName  = inEl    ? inEl.value.trim()    : '';
  const newEmoji = emojiEl ? (emojiEl.value.trim() || '🏷') : '🏷';
  if (!newName) return;
  if (DATA.categories.indexOf(newName) !== -1 && newName !== old) {
    alert('Category already exists.');
    return;
  }
  DATA.categories = DATA.categories.map(function(c){ return c === old ? newName : c; });
  DATA.prompts = DATA.prompts.map(function(p){
    return Object.assign({}, p, { category: p.category === old ? newName : p.category });
  });
  if (!DATA.categoryEmojis) DATA.categoryEmojis = {};
  const prevEmoji = DATA.categoryEmojis[old];
  if (old !== newName) delete DATA.categoryEmojis[old];
  DATA.categoryEmojis[newName] = newEmoji || prevEmoji || '🏷';
  if (CAT === old) CAT = newName;
  EDITING_CAT = null;
  save();
  renderCatTabs();
  renderSidebar();
  renderGallery();
  renderAdminContent();
}

/* ---------- GitHub Sync tab ---------- */

function renderGitHub(){
  // Count pending data: images across all prompts
  let pendingCount = 0;
  DATA.prompts.forEach(function(p){
    (p.images || [p.imageUrl]).forEach(function(u){
      if (u && u.startsWith('data:')) pendingCount++;
    });
  });
  const pendingBadge = pendingCount > 0 ? '' : ''; // (kept for parity)
  const stsHtml      = GH_STS      ? '<div class="sts '+GH_STS+'">'+GH_MSG+'</div>' : '';
  const progressHtml = GH_PROGRESS ? '<div class="sts loading" id="gh-progress-msg">'+esc(GH_PROGRESS)+'</div>' : '';
  return '<div class="gh-info"><strong>Local-first workflow:</strong> Add & edit prompts freely — images are stored as data URLs in your browser. When ready, enter your token below and click <strong>Push to GitHub</strong> to batch-upload all pending images and publish the complete site.<br><br>Needs a <a href="https://github.com/settings/tokens" target="_blank" style="color:var(--gold)">Personal Access Token</a> with <code>repo</code> scope.</div>'
    + pendingBadge
    + stsHtml
    + progressHtml
    + '<div><label class="afl">Personal Access Token</label>'
    +   '<input class="afi" id="gh-tok" type="password" placeholder="ghp_…" value="" oninput="GH.token=this.value"></div>'
    + '<div class="afrow">'
    +   '<div><label class="afl">Owner (GitHub username)</label>'
    +     '<input class="afi" id="gh-own" type="text" placeholder="rdjpublishers" value="'+ea(GH.owner)+'" oninput="GH.owner=this.value"></div>'
    +   '<div><label class="afl">Repository name</label>'
    +     '<input class="afi" id="gh-rep" type="text" placeholder="Prompt-Gallery" value="'+ea(GH.repo)+'" oninput="GH.repo=this.value"></div>'
    + '</div>'
    + '<div class="gh-path-info">📁 Pushes to: <strong>github.com/'+(GH.owner||'owner')+'/'+(GH.repo||'repo')+'/index.html</strong> · Images: <code>images/img-*.ext</code></div>'
    + '<div class="brow"><button class="bg" style="flex:1;justify-content:center" onclick="ghPush()">🚀 Push to GitHub</button></div>';
}

function ghSync(){
  const tokEl = document.getElementById('gh-tok');
  const ownEl = document.getElementById('gh-own');
  const repEl = document.getElementById('gh-rep');
  GH.token = (tokEl ? tokEl.value : GH.token) || GH.token;
  GH.owner = (ownEl ? ownEl.value : GH.owner) || GH.owner;
  GH.repo  = (repEl ? repEl.value : GH.repo)  || GH.repo;
  GH.path  = 'index.html';
}

async function uploadDataUrlToRepo(dataUrl, token, owner, repo){
  const matches = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
  if (!matches) throw new Error('Invalid data URL');
  const mime = matches[1];
  const b64  = matches[2];
  const ext  = (mime.split('/')[1]) || 'jpg';
  const fname = 'images/img-' + Date.now() + '-' + Math.random().toString(36).slice(2, 5) + '.' + ext;
  const api = 'https://api.github.com/repos/'+owner+'/'+repo+'/contents/'+fname;
  const put = await fetch(api, {
    method: 'PUT',
    headers: {
      'Authorization': 'token '+token,
      'Accept': 'application/vnd.github+json',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      message: 'Add prompt image — ' + new Date().toLocaleString(),
      content: b64
    })
  });
  if (!put.ok) {
    const e = await put.json();
    throw new Error(e.message || 'Image upload failed');
  }
  // Use raw.githubusercontent.com URL for reliable image serving.
  return 'https://raw.githubusercontent.com/'+owner+'/'+repo+'/main/'+fname;
}

async function ghPush(){
  ghSync();
  if (!GH.token || !GH.owner || !GH.repo) {
    GH_STS = 'err';
    GH_MSG = 'Fill in Token, Owner and Repository.';
    GH_PROGRESS = '';
    renderAdminContent();
    return;
  }
  GH_STS = 'loading';
  GH_MSG = '';
  GH_PROGRESS = 'Scanning for local images…';
  renderAdminContent();
  const token = GH.token, owner = GH.owner, repo = GH.repo;

  // Step 1: collect all data: URLs across all prompts.
  const replacements = []; // [{promptId, imgIndex, dataUrl}]
  DATA.prompts.forEach(function(p){
    const imgs = (p.images && p.images.length) ? p.images : [p.imageUrl];
    imgs.forEach(function(url, i){
      if (url && url.startsWith('data:')) replacements.push({ promptId: p.id, imgIndex: i, dataUrl: url });
    });
  });
  const total = replacements.length;
  if (total === 0) {
    GH_PROGRESS = ''; // No data URLs — just push index.html.
  } else {
    // Step 2: upload each data URL to GitHub.
    for (let n = 0; n < total; n++) {
      const r = replacements[n];
      GH_PROGRESS = 'Uploading image '+(n+1)+' of '+total+'…';
      const el = document.getElementById('gh-progress-msg');
      if (el) el.textContent = GH_PROGRESS;
      try {
        const uploadedUrl = await uploadDataUrlToRepo(r.dataUrl, token, owner, repo);
        // Replace data URL with real URL in DATA.
        const p = DATA.prompts.find(function(x){ return x.id === r.promptId; });
        if (p) {
          if (p.images && p.images.length) p.images[r.imgIndex] = uploadedUrl;
          else p.imageUrl = uploadedUrl;
          // Keep imageUrl (cover) in sync with first image.
          if (r.imgIndex === 0) p.imageUrl = uploadedUrl;
        }
      } catch (e) {
        GH_STS = 'err';
        GH_MSG = '❌ Image upload failed (image '+(n+1)+'): '+e.message;
        GH_PROGRESS = '';
        save();
        renderAdminContent();
        return;
      }
    }
    // Persist updated URLs (data: replaced with real URLs) to localStorage.
    save();
    GH_PROGRESS = 'All images uploaded. Building index.html…';
    const el2 = document.getElementById('gh-progress-msg');
    if (el2) el2.textContent = GH_PROGRESS;
  }

  // Step 3: push index.html.
  try {
    const OPEN  = '<script id="pg-data" type="application/json">';
    const CLOSE = '</'+'script>';
    const newData  = JSON.stringify(DATA, null, 2);
    let pageHtml = '<!DOCTYPE html>\n' + document.documentElement.outerHTML;
    pageHtml = pageHtml.replace(/(<input[^>]*id="gh-tok"[^>]*value=")[^"]*(")/g, '$1$2');
    pageHtml = pageHtml.replace(/(<body\b[^>]*?)\s*style="overflow:\s*hidden;?"/i, '$1');
    pageHtml = pageHtml.replace(/<div class="sts (?:loading|ok|err)">[^<]*<\/div>/g, '');
    const si = pageHtml.indexOf(OPEN);
    const ei = pageHtml.indexOf(CLOSE, si + OPEN.length);
    if (si === -1 || ei === -1) throw new Error('Data block not found — reload and try again.');
    pageHtml = pageHtml.slice(0, si + OPEN.length) + '\n' + newData + '\n' + pageHtml.slice(ei);

    const apiUrl = 'https://api.github.com/repos/'+owner+'/'+repo+'/contents/index.html';
    const hdr = {
      'Authorization': 'Bearer '+token,
      'Accept': 'application/vnd.github+json',
      'Content-Type': 'application/json'
    };
    let sha;
    const getRes = await fetch(apiUrl, { headers: hdr });
    if (getRes.ok) sha = (await getRes.json()).sha;
    else if (getRes.status !== 404) throw new Error('GitHub API: '+getRes.status);

    const content = btoa(unescape(encodeURIComponent(pageHtml)));
    const body = {
      message: 'Update Prompt Gallery — '+new Date().toLocaleString()
               + (total > 0 ? ' ('+total+' image'+(total!==1?'s':'')+' uploaded)' : ''),
      content: content
    };
    if (sha) body.sha = sha;
    const putRes = await fetch(apiUrl, { method: 'PUT', headers: hdr, body: JSON.stringify(body) });
    if (!putRes.ok) {
      const e = await putRes.json();
      throw new Error(e.message || 'Push failed: '+putRes.status);
    }
    GH_STS = 'ok';
    GH_MSG = '✅ Published to github.com/'+owner+'/'+repo
             + (total > 0 ? ' — '+total+' image'+(total!==1?'s':'')+' uploaded' : '')
             + ' — site updates in ~30 sec.';
    GH_PROGRESS = '';
    GH.token = '';
    saveGH();
    renderAdminContent();
  } catch (e) {
    GH_STS = 'err';
    GH_MSG = '❌ '+(e.message || 'Push failed.');
    GH_PROGRESS = '';
    renderAdminContent();
  }
}
