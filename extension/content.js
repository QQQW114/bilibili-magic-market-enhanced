(() => {
  'use strict';

  if (window.__BMM_SEARCH_ENHANCER__) return;
  window.__BMM_SEARCH_ENHANCER__ = true;

  const STORE_KEY = 'bmm-search-enhancer-keyword';
  const CACHE_KEY = 'bmm-search-enhancer-session-cache-v2';
  const DETAIL_URL = 'https://mall.bilibili.com/neul-next/index.html?page=magic-market_detail&noTitleBar=1&itemsId=';
  const ALLOWED_PAGE_RE = /(?:\?|&)page=magic-market_(?:index|search-result)(?:&|$)/;
  const PAGES_PER_BATCH = 4;
  const REQUEST_DELAY_MS = 6000;
  const REQUEST_JITTER_MS = 2000;
  const BAN_COOLDOWN_MS = 120000;

  const state = {
    keyword: '',
    lastAppliedKeyword: '',
    nextId: null,
    resultKeyword: '',
    results: [],
    seenIds: new Set(),
    scannedItems: [],
    seenScanIds: new Set(),
    scannedCount: 0,
    scannedPages: 0,
    reachedEnd: false,
    searching: false,
    continuousScanning: false,
    stopRequested: false,
    cooldownUntil: 0,
    observer: null,
    stats: { total: 0, shown: 0 },
  };

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

  const escapeHTML = (value) => String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

  const normalizeText = (value) => String(value ?? '')
    .toLowerCase()
    .normalize('NFKC')
    .replace(/\s+/g, ' ')
    .trim();

  const debounce = (fn, wait = 250) => {
    let timer = 0;
    return (...args) => {
      clearTimeout(timer);
      timer = window.setTimeout(() => fn(...args), wait);
    };
  };

  const delay = (ms) => new Promise((resolve) => window.setTimeout(resolve, ms));

  function createRoot() {
    const root = document.createElement('section');
    root.id = 'bmm-enhancer';
    root.setAttribute('aria-label', 'Bilibili 市集搜索增强');
    root.innerHTML = `
      <div class="bmm-card">
        <div class="bmm-head">
          <div>
            <div class="bmm-title">市集搜索增强</div>
            <div class="bmm-subtitle">筛选当前页 / 扫描市集接口</div>
          </div>
          <button type="button" class="bmm-icon-btn" data-bmm-action="toggle" title="收起/展开">−</button>
        </div>
        <div class="bmm-body">
          <label class="bmm-input-wrap">
            <span class="bmm-search-icon">⌕</span>
            <input class="bmm-input" type="search" placeholder="输入商品名、系列名或 UP 主" autocomplete="off" />
            <button type="button" class="bmm-clear" data-bmm-action="clear" title="清空">×</button>
          </label>
          <div class="bmm-actions">
            <button type="button" class="bmm-btn bmm-primary" data-bmm-action="search">扫描搜索</button>
            <button type="button" class="bmm-btn" data-bmm-action="filter">筛选已加载</button>
            <button type="button" class="bmm-btn" data-bmm-action="reset">显示全部</button>
          </div>
          <div class="bmm-actions bmm-actions-continuous">
            <button type="button" class="bmm-btn bmm-primary" data-bmm-action="continuous">开始连续扫描</button>
            <button type="button" class="bmm-btn bmm-danger" data-bmm-action="stop" disabled>停止</button>
          </div>
          <div class="bmm-stats">等待页面商品加载…</div>
          <div class="bmm-hint">原官方 search 接口会返回“请求错误”，现改为慢速扫描列表接口：每批 ${PAGES_PER_BATCH} 页，连续模式每次请求间隔约 6–8 秒。</div>
        </div>
      </div>
      <div class="bmm-results bmm-hidden" role="dialog" aria-label="搜索结果">
        <div class="bmm-results-head">
          <div>
            <div class="bmm-results-title">扫描搜索结果</div>
            <div class="bmm-results-subtitle"></div>
          </div>
          <button type="button" class="bmm-icon-btn" data-bmm-action="close-results" title="关闭">×</button>
        </div>
        <div class="bmm-results-body">
          <div class="bmm-message">请输入关键词后点击“扫描搜索”。</div>
          <div class="bmm-grid"></div>
          <button type="button" class="bmm-load-more bmm-hidden" data-bmm-action="load-more">继续扫描更多</button>
        </div>
      </div>
      <div class="bmm-toast bmm-hidden"></div>
    `;
    document.documentElement.appendChild(root);
    return root;
  }

  function init() {
    if (!ALLOWED_PAGE_RE.test(location.search)) return;

    const root = createRoot();
    const input = $('.bmm-input', root);
    const urlKeyword = getUrlKeyword();
    const saved = urlKeyword || localStorage.getItem(STORE_KEY) || '';
    input.value = saved;
    state.keyword = saved.trim();
    restoreCache();
    if (state.keyword) rebuildResultsFromCache(state.keyword);

    root.addEventListener('click', (event) => {
      const actionEl = event.target.closest('[data-bmm-action]');
      if (!actionEl || !root.contains(actionEl)) return;
      const action = actionEl.getAttribute('data-bmm-action');
      if (action === 'toggle') togglePanel(root, actionEl);
      if (action === 'clear') clearKeyword(root);
      if (action === 'filter') applyFilter(root, true);
      if (action === 'reset') resetFilter(root);
      if (action === 'search') scanMarket(root, true, false);
      if (action === 'continuous') startContinuousScan(root);
      if (action === 'stop') stopScan(root);
      if (action === 'close-results') closeResults(root);
      if (action === 'load-more') scanMarket(root, false, false);
    });

    $('.bmm-grid', root).addEventListener('click', (event) => {
      const card = event.target.closest('[data-bmm-items-id]');
      if (!card) return;
      const id = card.getAttribute('data-bmm-items-id');
      if (!id) return;
      location.href = `${DETAIL_URL}${encodeURIComponent(id)}&from=market_search_result`;
    });

    input.addEventListener('input', () => {
      state.keyword = input.value.trim();
      localStorage.setItem(STORE_KEY, state.keyword);
      debouncedFilter(root);
    });

    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        scanMarket(root, true, false);
      }
    });

    observeGoods(root);
    window.setTimeout(() => applyFilter(root, false), 800);

    if (state.keyword && (state.scannedItems.length || state.results.length || /page=magic-market_search-result/.test(location.search))) {
      openResults(root);
      renderResults(root, state.scannedItems.length
        ? {}
        : { message: `已填入关键词“${state.keyword}”。点击“扫描搜索”或“开始连续扫描”后才会请求接口。` });
      showToast(root, state.scannedItems.length ? '已恢复上次临时扫描结果' : '已就绪，等待手动开始扫描');
    } else {
      showToast(root, '增强搜索已启用：使用列表接口逐页扫描');
    }
  }

  function getUrlKeyword() {
    try {
      return (new URLSearchParams(location.search).get('keyword') || '').trim();
    } catch (error) {
      return '';
    }
  }

  const debouncedFilter = debounce((root) => applyFilter(root, false), 220);

  function togglePanel(root, btn) {
    root.classList.toggle('bmm-collapsed');
    btn.textContent = root.classList.contains('bmm-collapsed') ? '+' : '−';
  }

  function clearKeyword(root) {
    const input = $('.bmm-input', root);
    input.value = '';
    state.keyword = '';
    localStorage.removeItem(STORE_KEY);
    resetFilter(root);
    input.focus();
  }

  function getGoodsCards() {
    return $$('.goods').filter((card) => !card.closest('#bmm-enhancer'));
  }

  function getHideTarget(card) {
    const parent = card.parentElement;
    if (parent && parent.children.length === 1) return parent;
    return card;
  }

  function cardText(card) {
    const name = $('.goods-name', card)?.textContent || '';
    const seller = $('.goods-seller', card)?.textContent || '';
    const price = $('.goods-price', card)?.textContent || '';
    return normalizeText(`${name} ${seller} ${price} ${card.textContent || ''}`);
  }

  function collectStrings(value, depth = 0, output = []) {
    if (value == null || depth > 5 || output.length > 300) return output;
    if (typeof value === 'string' || typeof value === 'number') {
      output.push(String(value));
      return output;
    }
    if (Array.isArray(value)) {
      value.slice(0, 30).forEach((entry) => collectStrings(entry, depth + 1, output));
      return output;
    }
    if (typeof value === 'object') {
      Object.entries(value).slice(0, 80).forEach(([key, entry]) => {
        output.push(String(key));
        collectStrings(entry, depth + 1, output);
      });
    }
    return output;
  }

  function itemText(item) {
    return normalizeText(collectStrings(item).join(' '));
  }

  function matchKeyword(text, keyword) {
    const q = normalizeText(keyword);
    if (!q) return true;
    const tokens = q.split(/[\s,，、]+/).filter(Boolean);
    return tokens.every((token) => text.includes(token));
  }

  function applyFilter(root, manual) {
    const keyword = state.keyword;
    const cards = getGoodsCards();
    let shown = 0;
    for (const card of cards) {
      const ok = matchKeyword(cardText(card), keyword);
      const target = getHideTarget(card);
      target.classList.toggle('bmm-filter-hidden', !ok);
      if (ok) shown += 1;
    }
    state.lastAppliedKeyword = keyword;
    state.stats = { total: cards.length, shown };
    updateStats(root);
    if (manual) showToast(root, keyword ? `已筛选：${shown}/${cards.length}` : '已显示全部商品');
  }

  function resetFilter(root) {
    state.keyword = '';
    state.lastAppliedKeyword = '';
    const input = $('.bmm-input', root);
    input.value = '';
    localStorage.removeItem(STORE_KEY);
    for (const card of getGoodsCards()) getHideTarget(card).classList.remove('bmm-filter-hidden');
    state.stats = { total: getGoodsCards().length, shown: getGoodsCards().length };
    updateStats(root);
    showToast(root, '已恢复显示全部已加载商品');
  }

  function updateStats(root) {
    const stats = $('.bmm-stats', root);
    const q = state.lastAppliedKeyword || state.keyword;
    const total = state.stats.total;
    const shown = q ? state.stats.shown : total;
    stats.textContent = total
      ? (q ? `当前页已加载 ${total} 个，匹配 ${shown} 个` : `当前页已加载 ${total} 个商品`)
      : '等待页面商品加载…';
  }

  function observeGoods(root) {
    if (state.observer) state.observer.disconnect();
    const schedule = debounce(() => applyFilter(root, false), 300);
    state.observer = new MutationObserver((mutations) => {
      if (mutations.some((m) => Array.from(m.addedNodes).some((node) => node.nodeType === 1 && !node.closest?.('#bmm-enhancer')))) schedule();
    });
    state.observer.observe(document.body, { childList: true, subtree: true });
  }

  function resetScan(keyword) {
    state.resultKeyword = keyword;
    state.results = [];
    state.seenIds = new Set();
    rebuildResultsFromCache(keyword);
  }

  function itemKey(item, fallback = '') {
    return String(item?.c2cItemsId || item?.itemsId || item?.id || item?.skuId || fallback || '');
  }

  function compactItem(item) {
    const detailList = Array.isArray(item?.detailDtoList) ? item.detailDtoList.slice(0, 8).map((entry) => ({
      blindBoxId: entry?.blindBoxId,
      itemsId: entry?.itemsId,
      skuId: entry?.skuId,
      name: entry?.name,
      img: entry?.img,
      marketPrice: entry?.marketPrice,
      type: entry?.type,
    })) : [];
    return {
      c2cItemsId: item?.c2cItemsId,
      itemsId: item?.itemsId,
      id: item?.id,
      type: item?.type,
      c2cItemsName: item?.c2cItemsName || item?.itemsName || item?.name,
      detailDtoList: detailList,
      totalItemsCount: item?.totalItemsCount,
      price: item?.price,
      showPrice: item?.showPrice,
      showMarketPrice: item?.showMarketPrice,
      uname: item?.uname || item?.sellerName || item?.nickName,
      uface: item?.uface,
      status: item?.status,
      saleStatus: item?.saleStatus,
    };
  }

  function addScannedItems(list) {
    let added = 0;
    for (const item of list || []) {
      const key = itemKey(item, `${state.scannedPages}-${added}-${state.scannedItems.length}`);
      if (!key || state.seenScanIds.has(key)) continue;
      state.seenScanIds.add(key);
      state.scannedItems.push(compactItem(item));
      added += 1;
    }
    state.scannedCount = state.scannedItems.length;
    return added;
  }

  function rebuildResultsFromCache(keyword) {
    state.resultKeyword = keyword;
    state.results = [];
    state.seenIds = new Set();
    for (const item of state.scannedItems) {
      if (!matchKeyword(itemText(item), keyword)) continue;
      const key = itemKey(item, `${state.results.length}`);
      if (state.seenIds.has(key)) continue;
      state.seenIds.add(key);
      state.results.push(item);
    }
  }

  function persistCache() {
    try {
      const payload = {
        nextId: state.nextId,
        resultKeyword: state.resultKeyword,
        scannedItems: state.scannedItems.slice(-1500),
        scannedPages: state.scannedPages,
        reachedEnd: state.reachedEnd,
        savedAt: Date.now(),
      };
      sessionStorage.setItem(CACHE_KEY, JSON.stringify(payload));
    } catch (error) {
      console.warn('[bmm-enhancer] 缓存保存失败', error);
    }
  }

  function restoreCache() {
    try {
      const raw = sessionStorage.getItem(CACHE_KEY);
      if (!raw) return;
      const payload = JSON.parse(raw);
      const items = Array.isArray(payload?.scannedItems) ? payload.scannedItems : [];
      state.nextId = payload?.nextId || null;
      state.scannedItems = [];
      state.seenScanIds = new Set();
      for (const item of items) {
        const key = itemKey(item, `${state.scannedItems.length}`);
        if (!key || state.seenScanIds.has(key)) continue;
        state.seenScanIds.add(key);
        state.scannedItems.push(item);
      }
      state.scannedCount = state.scannedItems.length;
      state.scannedPages = Number(payload?.scannedPages) || Math.ceil(state.scannedCount / 10);
      state.reachedEnd = !!payload?.reachedEnd;
      state.resultKeyword = payload?.resultKeyword || '';
    } catch (error) {
      console.warn('[bmm-enhancer] 缓存读取失败', error);
    }
  }

  function startContinuousScan(root) {
    const input = $('.bmm-input', root);
    const keyword = input.value.trim();
    if (state.searching) {
      showToast(root, state.continuousScanning ? '连续扫描已在运行' : '正在扫描中，请稍候');
      return;
    }
    const shouldReset = state.resultKeyword !== keyword || !state.resultKeyword;
    scanMarket(root, shouldReset, true);
  }

  function stopScan(root) {
    if (!state.searching) {
      showToast(root, '当前没有正在运行的扫描');
      return;
    }
    state.stopRequested = true;
    state.continuousScanning = false;
    renderResults(root, { loading: true, message: `正在停止，等待当前请求/倒计时结束。${scanProgressText()}` });
    showToast(root, '已请求停止扫描');
    setLoading(root, true);
  }

  async function scanMarket(root, reset, continuous = false) {
    const input = $('.bmm-input', root);
    const keyword = input.value.trim();
    state.keyword = keyword;
    localStorage.setItem(STORE_KEY, keyword);

    if (!keyword) {
      showToast(root, '请输入关键词');
      input.focus();
      return;
    }
    if (state.searching) return;

    if (reset || state.resultKeyword !== keyword) {
      resetScan(keyword);
      openResults(root);
      renderResults(root, { loading: true, message: continuous
        ? `准备连续扫描：已复用临时缓存 ${state.scannedItems.length} 个商品，每次请求前等待 6–8 秒，可手动停止。`
        : `正在慢速扫描：已复用临时缓存 ${state.scannedItems.length} 个商品；每批 ${PAGES_PER_BATCH} 页，每次请求间隔约 6–8 秒…` });
    } else if (state.reachedEnd) {
      renderResults(root);
      showToast(root, '已经扫描到底了');
      return;
    } else {
      openResults(root);
    }

    state.searching = true;
    state.continuousScanning = !!continuous;
    state.stopRequested = false;
    setLoading(root, true);

    try {
      let fetchedPages = 0;
      while ((continuous || fetchedPages < PAGES_PER_BATCH) && !state.reachedEnd && !state.stopRequested) {
        const shouldContinue = await waitBeforeRequest(root, fetchedPages);
        if (!shouldContinue || state.stopRequested) break;

        const payload = await requestList(state.nextId);
        if (state.stopRequested) break;

        const list = Array.isArray(payload.data) ? payload.data : (Array.isArray(payload.list) ? payload.list : []);
        state.scannedPages += 1;
        addScannedItems(list);
        rebuildResultsFromCache(keyword);

        state.nextId = payload.nextId || payload.next_id || null;
        if (!state.nextId || list.length === 0) state.reachedEnd = true;
        fetchedPages += 1;
        persistCache();
        renderResults(root, { loading: true, message: scanProgressText() });
      }

      renderResults(root);
      applyFilter(root, false);

      if (state.stopRequested) {
        showToast(root, `已停止，累计扫描 ${state.scannedPages} 页，找到 ${state.results.length} 个`);
      } else if (state.reachedEnd) {
        showToast(root, `已扫描到底，累计找到 ${state.results.length} 个`);
      } else if (continuous) {
        showToast(root, `连续扫描已结束，累计找到 ${state.results.length} 个`);
      } else {
        showToast(root, `本批扫描 ${fetchedPages} 页，累计找到 ${state.results.length} 个`);
      }
    } catch (error) {
      if (error && error.banned) {
        const retryMs = error.retryMs || BAN_COOLDOWN_MS;
        state.cooldownUntil = Date.now() + retryMs;
        const msg = `${error.message || '请求被限流'}，已进入 ${Math.ceil(retryMs / 1000)} 秒冷却，请稍后再继续扫描。`;
        renderResults(root, { error: true, message: msg });
        showToast(root, '触发限流，已自动冷却');
      } else {
        renderResults(root, { error: true, message: error.message || '扫描失败' });
        showToast(root, error.message || '扫描失败');
      }
    } finally {
      persistCache();
      state.searching = false;
      state.continuousScanning = false;
      state.stopRequested = false;
      setLoading(root, false);
    }
  }

  function scanProgressText() {
    const cool = Math.max(0, state.cooldownUntil - Date.now());
    const coolText = cool ? `，冷却剩余 ${Math.ceil(cool / 1000)} 秒` : '';
    const modeText = state.continuousScanning ? '，连续模式' : '';
    return `已扫描 ${state.scannedPages} 页 / ${state.scannedCount} 个商品，找到 ${state.results.length} 个匹配项${modeText}${coolText}…`;
  }

  async function waitBeforeRequest(root, fetchedPagesInBatch) {
    const now = Date.now();
    if (state.cooldownUntil > now) {
      const ok = await countdownWait(root, state.cooldownUntil - now, '限流冷却中');
      if (!ok) return false;
    }
    const waitMs = REQUEST_DELAY_MS + Math.floor(Math.random() * REQUEST_JITTER_MS);
    const label = fetchedPagesInBatch === 0 && state.scannedPages === 0 ? '首次请求前等待' : '请求间隔等待';
    return countdownWait(root, waitMs, label);
  }

  async function countdownWait(root, waitMs, label) {
    const end = Date.now() + Math.max(0, waitMs);
    while (Date.now() < end) {
      if (state.stopRequested) return false;
      const left = Math.ceil((end - Date.now()) / 1000);
      renderResults(root, { loading: true, message: `${label}：${left} 秒。${scanProgressText()}` });
      await delay(Math.min(1000, Math.max(0, end - Date.now())));
    }
    return !state.stopRequested;
  }

  function makeBannedError(message, response) {
    const error = new Error(message || 'request was banned / 请求被限流');
    error.banned = true;
    const retryAfter = Number(response && response.headers && response.headers.get('retry-after'));
    error.retryMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : BAN_COOLDOWN_MS;
    return error;
  }

  async function requestList(nextId) {
    const response = await fetch('/mall-magic-c/internet/c2c/v2/list', {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Accept': 'application/json, text/plain, */*',
        'Content-Type': 'application/json;charset=UTF-8',
      },
      body: JSON.stringify({ sortType: 'TIME_DESC', nextId: nextId || null, csrf: getCookie('bili_jct') || '' }),
    });

    const text = await response.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : {};
    } catch (error) {
      if (response.status === 429 || /request\s+was\s+banned|banned|too\s+many\s+requests|rate\s*limit|频繁|限流/i.test(text)) {
        throw makeBannedError(text.slice(0, 120), response);
      }
      throw new Error(`接口返回异常：HTTP ${response.status}`);
    }

    const message = json?.message || '';
    if (response.status === 429 || /request\s+was\s+banned|banned|too\s+many\s+requests|rate\s*limit|频繁|限流/i.test(message)) {
      throw makeBannedError(message, response);
    }
    if (json && (json.code === 71102072 || /登录|登陆/.test(message))) {
      throw new Error('登录验证失败：请先在当前浏览器登录 B 站商城，然后刷新页面。');
    }
    if (!response.ok) throw new Error(message || `接口请求失败：HTTP ${response.status}`);
    if (json && json.code && json.code !== 0 && json.success !== true) throw new Error(message || `接口错误：${json.code}`);
    return json?.data || {};
  }

  function getCookie(name) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = document.cookie.match(new RegExp(`(?:^|; )${escaped}=([^;]*)`));
    return match ? decodeURIComponent(match[1]) : '';
  }

  function openResults(root) {
    $('.bmm-results', root).classList.remove('bmm-hidden');
  }

  function closeResults(root) {
    $('.bmm-results', root).classList.add('bmm-hidden');
  }

  function setLoading(root, loading) {
    root.classList.toggle('bmm-loading', !!loading);
    const primary = $('[data-bmm-action="search"]', root);
    const continuous = $('[data-bmm-action="continuous"]', root);
    const stop = $('[data-bmm-action="stop"]', root);
    const loadMore = $('[data-bmm-action="load-more"]', root);
    if (primary) {
      primary.textContent = loading && !state.continuousScanning ? '扫描中…' : '扫描搜索';
      primary.disabled = !!loading;
    }
    if (continuous) {
      continuous.textContent = state.continuousScanning ? '连续扫描中…' : '开始连续扫描';
      continuous.disabled = !!loading;
    }
    if (stop) stop.disabled = !loading;
    if (loadMore) loadMore.disabled = !!loading;
  }

  function renderResults(root, options = {}) {
    const title = $('.bmm-results-title', root);
    const subtitle = $('.bmm-results-subtitle', root);
    const message = $('.bmm-message', root);
    const grid = $('.bmm-grid', root);
    const loadMore = $('.bmm-load-more', root);

    title.textContent = `扫描：${state.resultKeyword || state.keyword || ''}`;
    subtitle.textContent = state.scannedCount
      ? `已缓存 ${state.scannedCount} 个，当前关键词找到 ${state.results.length} 个${state.continuousScanning ? '，连续中' : ''}${state.reachedEnd ? '，已到底' : ''}`
      : '';

    if (options.loading || options.error || options.message) {
      message.classList.remove('bmm-hidden');
      message.classList.toggle('bmm-error', !!options.error);
      message.textContent = options.message || '';
      if (options.loading && !state.results.length) grid.innerHTML = '';
    } else if (!state.results.length) {
      message.classList.remove('bmm-hidden');
      message.classList.remove('bmm-error');
      message.textContent = state.reachedEnd
        ? `已扫描到底，没有找到“${state.resultKeyword}”。`
        : `已缓存 ${state.scannedCount} 个，暂未匹配。可以继续扫描更多，或换关键词复用当前缓存。`;
    } else {
      message.classList.add('bmm-hidden');
      message.classList.remove('bmm-error');
    }

    if (!options.loading || state.results.length) grid.innerHTML = state.results.map(renderResultCard).join('');
    loadMore.textContent = state.reachedEnd ? '已扫描到底' : `继续慢速扫描（每批 ${PAGES_PER_BATCH} 页）`;
    loadMore.classList.toggle('bmm-hidden', state.reachedEnd || !!options.error);
  }

  function renderResultCard(item) {
    const id = item.c2cItemsId || item.itemsId || item.id || '';
    const name = item.c2cItemsName || item.itemsName || item.name || '未命名商品';
    const seller = item.uname || item.sellerName || item.nickName || '';
    const price = formatPrice(item);
    const marketPrice = item.showMarketPrice ? `<span class="bmm-market-price">¥${escapeHTML(item.showMarketPrice)}</span>` : '';
    const img = findImage(item);
    const imgHtml = img
      ? `<img src="${escapeHTML(img)}" alt="" loading="lazy" />`
      : `<div class="bmm-no-img">No Image</div>`;
    return `
      <article class="bmm-result-card" data-bmm-items-id="${escapeHTML(id)}" title="打开详情">
        <div class="bmm-thumb">${imgHtml}</div>
        <div class="bmm-result-name">${escapeHTML(name)}</div>
        <div class="bmm-result-price">${price}${marketPrice}</div>
        ${seller ? `<div class="bmm-result-seller">${escapeHTML(seller)}</div>` : ''}
      </article>
    `;
  }

  function formatPrice(item) {
    const direct = item.showPrice ?? item.priceText ?? item.price;
    if (direct === undefined || direct === null || direct === '') return '';
    if (typeof direct === 'number') {
      const value = direct > 1000 ? direct / 100 : direct;
      return `¥${escapeHTML(value.toFixed(value % 1 ? 2 : 0))}`;
    }
    return `¥${escapeHTML(String(direct).replace(/^[¥￥]\s*/, ''))}`;
  }

  function findImage(item) {
    const preferredKeys = ['img', 'image', 'pic', 'picture', 'cover', 'coverUrl', 'imageUrl', 'imgUrl', 'skuImg', 'skuImgUrl', 'skuPic', 'itemsImg', 'c2cItemsImage', 'url'];
    const candidates = [];

    const visit = (value, depth = 0) => {
      if (!value || depth > 4 || candidates.length) return;
      if (typeof value === 'string') {
        if (looksLikeImage(value)) candidates.push(value);
        return;
      }
      if (Array.isArray(value)) {
        value.slice(0, 12).forEach((entry) => visit(entry, depth + 1));
        return;
      }
      if (typeof value === 'object') {
        for (const key of preferredKeys) {
          if (Object.prototype.hasOwnProperty.call(value, key)) visit(value[key], depth + 1);
        }
        for (const [key, entry] of Object.entries(value)) {
          if (/img|image|pic|cover|url/i.test(key)) visit(entry, depth + 1);
        }
      }
    };

    visit(item.detailDtoList || item.skuList || item);
    return normalizeImageUrl(candidates[0] || '');
  }

  function looksLikeImage(value) {
    return /(?:^https?:)?\/\//.test(value) && /(?:bfs|hdslb|\.jpg|\.jpeg|\.png|\.webp|\.gif)/i.test(value);
  }

  function normalizeImageUrl(url) {
    if (!url) return '';
    if (url.startsWith('//')) return `https:${url}`;
    if (url.startsWith('http://')) return url.replace(/^http:\/\//, 'https://');
    return url;
  }

  function showToast(root, text) {
    const toast = $('.bmm-toast', root);
    toast.textContent = text;
    toast.classList.remove('bmm-hidden');
    clearTimeout(showToast.timer);
    showToast.timer = window.setTimeout(() => toast.classList.add('bmm-hidden'), 2600);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
