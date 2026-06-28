// ==UserScript==
// @name         黄金积存金实时监测- 价格提醒版
// @namespace    https://github.com/zhou2533/GoldAccumulationRealTimeMonitor
// @version      2.1.0
// @description  实时监测9家银行积存金及国际金价，支持持仓管理、盈亏计算、自定义价格提醒（桌面通知）
// @author       zhou2533
// @match        https://www.baidu.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_addStyle
// @grant        GM_registerMenuCommand
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_notification
// @connect      jin.20021002.xyz
// @connect      m.cmbchina.com
// @license      MIT
// ==/UserScript==

;(function () {
  'use strict'

  /* ============================================================
     Config & State
  ============================================================ */
  const CONFIG = {
    apiBase: 'https://jin.20021002.xyz/api.php',
    banks: [
      { key: 'ms', name: '民生银行', icon: '🏦', logo: 'https://www.cmbc.com.cn/favicon.ico' },
      { key: 'zs', name: '浙商银行', icon: '🏦', logo: 'http://www.czbank.com/cn/images/favicon.ico' },
      { key: 'cib', name: '兴业银行', icon: '🏦', logo: 'https://www.cib.com.cn/favicon.ico' },
      { key: 'icbc', name: '工商银行', icon: '🏦', logo: 'https://www.icbc.com.cn/favicon.ico' },
      { key: 'cmb', name: '招商银行', icon: '🏦', logo: 'https://www.cmbchina.com/cmb.ico' },
      { key: 'cgb', name: '广发银行', icon: '🏦', logo: 'https://www.cgbchina.com.cn/favicon.ico' },
      { key: 'abc', name: '农业银行', icon: '🏦', logo: 'https://www.abchina.com/favicon.ico' },
      { key: 'ccb', name: '建设银行', icon: '🏦', logo: 'https://www.ccb.com/favicon.ico' },
      { key: 'boc', name: '中国银行', icon: '🏦', logo: 'https://www.boc.cn/favicon.ico' },
    ],
    ticker: [
      { key: 'jd', name: '京东24h金', icon: '🟡', logo: 'https://www.jd.com/favicon.ico' },
      { key: 'gj', name: '伦敦金', icon: '🌐', currency: '$' },
    ],
    defaultRefresh: 30,
    minRefresh: 10,
    maxRefresh: 300,
    alertCooldown: 300000,
  }

  const STATE = {
    prices: {},
    refreshInterval: GM_getValue('refreshInterval', CONFIG.defaultRefresh),
    cycleSeconds: GM_getValue('cycleSeconds', 10),
    hidden: GM_getValue('hidden', false),
    theme: GM_getValue('theme', 'dark'),
    holdings: loadHoldings(),
    alerts: loadAlerts(),
    loading: true,
    failCount: 0,
    timerId: null,
    initialized: false,
    pos: loadPosition(),
    toggleIdx: 0,
    toggleTimer: null,
    toggleBankKeys: [],
  }

  function loadAlerts() {
    try { return GM_getValue('alerts', []) } catch { return [] }
  }
  function saveAlerts() { GM_setValue('alerts', STATE.alerts) }

  function loadPosition() {
    try { return GM_getValue('panelPos', {}) } catch { return {} }
  }
  function savePosition() {
    const c = document.getElementById('gm-container')
    const t = document.getElementById('gm-toggle-btn')
    const data = {}
    if (c) { const s = c.style; data.left = s.left || ''; data.top = s.top || ''; data.right = s.right || ''; data.bottom = s.bottom || '' }
    if (t && t.style.display !== 'none') { data.toggleLeft = t.style.left || ''; data.toggleTop = t.style.top || ''; data.toggleRight = t.style.right || '' }
    GM_setValue('panelPos', data)
  }
  function loadHoldings() {
    try {
      return GM_getValue('holdings', { ms:{g:0,c:0}, zs:{g:0,c:0}, cib:{g:0,c:0}, icbc:{g:0,c:0}, cmb:{g:0,c:0}, cgb:{g:0,c:0}, abc:{g:0,c:0}, ccb:{g:0,c:0}, boc:{g:0,c:0} })
    } catch { return { ms:{g:0,c:0}, zs:{g:0,c:0}, cib:{g:0,c:0}, icbc:{g:0,c:0}, cmb:{g:0,c:0}, cgb:{g:0,c:0}, abc:{g:0,c:0}, ccb:{g:0,c:0}, boc:{g:0,c:0} } }
  }
  function saveHoldings() { GM_setValue('holdings', STATE.holdings) }
  function getHolding(key) { const h = STATE.holdings[key]; return h ? { g: h.g||0, c: h.c||0 } : { g:0, c:0 } }

  function calcPortfolio(bankKey) {
    const price = STATE.prices[bankKey], holding = getHolding(bankKey)
    const current = price ? price.price : 0, change = price ? price.change : 0
    const grams = holding.g, costPrice = holding.c
    const marketValue = current * grams, totalCost = costPrice * grams
    const profit = marketValue - totalCost
    const profitPct = totalCost > 0 ? ((current - costPrice) / costPrice) * 100 : 0
    const dailyProfit = change * grams
    return { current, change, changePct: price?.change_pct||0, grams, costPrice, marketValue, totalCost, profit, profitPct, dailyProfit }
  }

  /* ============================================================
     DOM Helper
  ============================================================ */
  function createEl(tag, attrs, children) {
    const el = document.createElement(tag)
    if (attrs) for (const [k, v] of Object.entries(attrs)) {
      if (k === 'style' && typeof v === 'object') Object.assign(el.style, v)
      else if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v)
      else el.setAttribute(k, v)
    }
    if (children) for (const c of children) {
      if (typeof c === 'string') el.appendChild(document.createTextNode(c))
      else el.appendChild(c)
    }
    return el
  }

  function showToast(text, parent) {
    const t = createEl('div', { class: 'gm-toast' })
    t.textContent = text
    ;(parent || document.body).appendChild(t)
    requestAnimationFrame(() => t.classList.add('gm-toast-in'))
    setTimeout(() => { t.classList.remove('gm-toast-in'); setTimeout(() => t.remove(), 300) }, 2800)
  }

  function createCustomSelect(items, opts={}) {
    const wrap = createEl('div', { class: 'gm-custom-select' })
    const trigger = createEl('div', { class: 'gm-cs-trigger' })
    const dropdown = createEl('div', { class: 'gm-cs-dropdown' })
    let selectedValue = opts.defaultValue || (items[0] && items[0].value)

    function findItem(val) { return items.find(i => i.value === val) }

    function renderTrigger() {
      const item = findItem(selectedValue)
      trigger.innerHTML = item ? `${logoHTML(item)}<span>${item.name}</span>` : '<span>选择</span>'
    }

    function renderDropdown() {
      dropdown.innerHTML = ''
      items.forEach(item => {
        const opt = createEl('div', {
          class: 'gm-cs-option' + (item.value === selectedValue ? ' selected' : ''),
          'data-value': item.value,
        })
        opt.innerHTML = `${logoHTML(item)}<span>${item.name}</span>`
        opt.addEventListener('click', (e) => {
          e.stopPropagation()
          selectedValue = item.value
          renderTrigger()
          dropdown.classList.remove('open')
          trigger.classList.remove('active')
          dropdown.querySelectorAll('.gm-cs-option').forEach(o => o.classList.toggle('selected', o.dataset.value === item.value))
          if (opts.onChange) opts.onChange(item.value)
        })
        dropdown.appendChild(opt)
      })
    }

    renderTrigger(); renderDropdown()
    wrap.appendChild(trigger); wrap.appendChild(dropdown)

    trigger.addEventListener('click', (e) => {
      e.stopPropagation()
      document.querySelectorAll('.gm-cs-dropdown.open').forEach(d => { if (d !== dropdown) d.classList.remove('open') })
      dropdown.classList.toggle('open')
      trigger.classList.toggle('active')
    })
    document.addEventListener('click', (e) => { if (!wrap.contains(e.target)) { dropdown.classList.remove('open'); trigger.classList.remove('active') } })

    Object.defineProperty(wrap, 'value', { get: () => selectedValue, set: v => { selectedValue = v; renderTrigger() } })
    return wrap
  }

  /* ============================================================
     API
  ============================================================ */
  function fetchWithRetry(fn, retries=1, delay=2000) {
    return fn().catch(err => {
      if (retries <= 0) throw err
      return new Promise((resolve, reject) => {
        setTimeout(() => {
          fetchWithRetry(fn, retries-1, delay*2).then(resolve).catch(reject)
        }, delay)
      })
    })
  }
  function fetchPrice(type) {
    if (type === 'cmb') return fetchWithRetry(fetchCMBPrice, 1, 2000)
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({ method:'GET', url:`${CONFIG.apiBase}?type=${type}`, timeout:10000,
        onload(r) { try { const d=JSON.parse(r.responseText); d.code===200?resolve(d.data):reject(new Error(d.msg)) } catch(e){reject(e)} },
        onerror: reject
      })
    })
  }
  function fetchCMBPrice() {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({ method:'GET', url:'https://m.cmbchina.com/api/rate/gold', headers:{'User-Agent':'Mozilla/5.0'}, timeout:10000,
        onload(r) {
          try {
            const d=JSON.parse(r.responseText), items=d.body?.data||[]
            const au=items.find(i=>i.variety==='Au99.99')
            if(au&&au.curPrice!=='0'){
              const p=parseFloat(au.curPrice), ch=parseFloat(au.upDown)
              resolve({ source:'CMB', name:'招商银行', symbol:'CMB', currency:'¥', price:p, change:ch,
                change_pct: p>0?Math.round((ch/(p-ch))*10000)/100:0, prev_close:p-ch,
                update_time:d.body.time?d.body.time.slice(-8,-3):'--', cached:false })
            } else reject(new Error('No Au99.99'))
          } catch(e){reject(e)}
        }, onerror: reject
      })
    })
  }

  async function refreshAllPrices() {
    const keys = [...CONFIG.banks.map(b=>b.key), ...CONFIG.ticker.map(b=>b.key)]
    let fails = 0
    for (const k of keys) {
      try {
        const data = await fetchPrice(k)
        data.cached = false
        STATE.prices[k] = data
      } catch {
        fails++
        if (STATE.prices[k]) STATE.prices[k] = { ...STATE.prices[k], cached: true }
      }
    }
    STATE.failCount = fails
    STATE.loading = false
    checkPriceAlerts()
    render()
    if (STATE.hidden) updateToggleDisplay()
  }

  /* ============================================================
     Price Alert Core Logic
  ============================================================ */
  function checkPriceAlerts() {
    const now = Date.now()
    let changed = false
    STATE.alerts.forEach(alert => {
      if (!alert.enabled) return
      const data = STATE.prices[alert.bankKey]
      if (!data || !data.price) return

      const triggered = alert.type === 'up' ? data.price >= alert.price : data.price <= alert.price
      if (triggered && (now - (alert.lastTriggered || 0)) > CONFIG.alertCooldown) {
        sendAlertNotification(alert, data)
        alert.lastTriggered = now
        changed = true
      }
    })
    if (changed) saveAlerts()
  }

  function sendAlertNotification(alert, data) {
    const allItems = [...CONFIG.banks, ...CONFIG.ticker]
    const item = allItems.find(b => b.key === alert.bankKey)
    const name = item ? item.name : alert.bankKey
    const dir = alert.type === 'up' ? '📈 突破上限' : '📉 跌破下限'
    const prefix = (item?.currency || '¥') === '$' ? '$' : '¥'

    GM_notification({
      title: `${dir} ${name}`,
      text: `当前价: ${prefix}${data.price.toFixed(2)}\n目标价: ${prefix}${alert.price.toFixed(2)}\n涨跌幅: ${data.change >= 0 ? '+' : ''}${data.change?.toFixed(2) || '--'}`,
      image: item?.logo || undefined,
      timeout: 8000,
      onclick: () => { showPanel(); window.focus() }
    })
  }

  /* ============================================================
     Helpers
  ============================================================ */
  function fmtPrice(v, currency) { return v==null?'--': currency==='$'?`$${v.toFixed(2)}`:`¥${v.toFixed(2)}` }
  function fmtChange(v) { return v==null?'--':(v>0?'+':'')+v.toFixed(2) }
  function isUp(d) { return d && d.change != null && d.change >= 0 }
  function shortName(name) { return name.slice(0, 2) }
  function logoHTML(b) { return b.logo ? `<img class="gm-bank-logo" src="${b.logo}" alt="" onerror="this.style.display='none'">` : (b.icon||'') }

  /* ============================================================
     Render
  ============================================================ */
  function getHeldBanks() { return CONFIG.banks.filter(b => { const h=getHolding(b.key); return h.g>0&&h.c>0 }) }
  function tickerItems() {
    const items = []
    CONFIG.ticker.forEach(t => { const d=STATE.prices[t.key]; if(d) items.push({...t, data:d, currency:t.currency||'¥'}) })
    getHeldBanks().forEach(b => { const d=STATE.prices[b.key]; if(d) items.push({...b, data:d, currency:'¥'}) })
    if (items.length <= CONFIG.ticker.length) {
      CONFIG.banks.forEach(b => { const d=STATE.prices[b.key]; if(d&&!items.find(i=>i.key===b.key)) items.push({...b, data:d, currency:'¥'}) })
    }
    return items
  }

  function renderTickerBar() {
    const items = tickerItems(), bar = createEl('div',{class:'gm-ticker-bar'}), wrap = createEl('div',{class:'gm-ticker-wrap'})
    const renderItems = (container) => {
      items.forEach(item => {
        const d=item.data, up=d&&d.change>=0, color=d?(up?'#e74c3c':'#2ecc71'):'#999'
        const el = createEl('div',{class:'gm-ticker-item'})
        el.innerHTML = `<span class="gm-ticker-icon">${logoHTML(item)}</span><span class="gm-ticker-name">${item.name}</span><span class="gm-ticker-price" style="color:${color}">${d?fmtPrice(d.price,item.currency):'--'}</span><span class="gm-ticker-arrow" style="color:${color}">${d?(up?'▲':'▼'):''}</span>`
        container.appendChild(el)
      })
    }
    if(items.length>0){renderItems(wrap);renderItems(wrap)}else{wrap.appendChild(createEl('div',{class:'gm-ticker-empty'},['加载中...']))}
    bar.appendChild(wrap); return bar
  }

  function renderPortfolioSection() {
    const held = getHeldBanks()
    if (held.length === 0) return null
    let totalMarket=0, totalCost=0, totalDaily=0
    const rows = createEl('div',{class:'gm-pf-section'})
    held.forEach(b => { const pf=calcPortfolio(b.key); totalMarket+=pf.marketValue; totalCost+=pf.totalCost; totalDaily+=pf.dailyProfit })
    const totalProfit=totalMarket-totalCost, totalPct=totalCost>0?(totalProfit/totalCost)*100:0
    const pColor=totalProfit>=0?'#e74c3c':'#2ecc71', dColor=totalDaily>=0?'#e74c3c':'#2ecc71'
    const totalDailyPct=totalMarket-totalDaily>0?(totalDaily/(totalMarket-totalDaily))*100:0

    const summ = createEl('div',{class:'gm-pf-summary'})
    summ.innerHTML = `<div class="gm-pf-summary-title">持仓汇总</div><div class="gm-pf-summary-grid"><div class="gm-pf-cell"><div class="gm-pf-cell-lbl">市值</div><div class="gm-pf-cell-val">¥${totalMarket.toFixed(2)}</div></div><div class="gm-pf-cell"><div class="gm-pf-cell-lbl">日盈亏</div><div class="gm-pf-cell-val" style="color:${dColor}">${totalDaily>=0?'+':''}¥${totalDaily.toFixed(2)}</div></div><div class="gm-pf-cell"><div class="gm-pf-cell-lbl">日收益率</div><div class="gm-pf-cell-val" style="color:${dColor}">${totalDailyPct>=0?'+':''}${totalDailyPct.toFixed(2)}%</div></div><div class="gm-pf-cell"><div class="gm-pf-cell-lbl">成本</div><div class="gm-pf-cell-val">¥${totalCost.toFixed(2)}</div></div><div class="gm-pf-cell"><div class="gm-pf-cell-lbl">总收益</div><div class="gm-pf-cell-val" style="color:${pColor}">${totalProfit>=0?'+':''}¥${totalProfit.toFixed(2)}</div></div><div class="gm-pf-cell"><div class="gm-pf-cell-lbl">总收益率</div><div class="gm-pf-cell-val" style="color:${pColor}">${totalPct>=0?'+':''}${totalPct.toFixed(2)}%</div></div></div>`
    rows.appendChild(summ)

    held.forEach(b => {
      const pf=calcPortfolio(b.key), data=STATE.prices[b.key], up=data&&data.change>=0
      const color=data?(up?'#f87171':'#34d399'):'#6b7280'
      const card=createEl('div',{class:'gm-pf-card'})
      const hdr=createEl('div',{class:'gm-pf-card-header'})
      hdr.innerHTML=`<span class="gm-pf-card-name">${logoHTML(b)} ${b.name}</span><span class="gm-pf-card-hold">${pf.grams.toFixed(2)}g</span>`
      card.appendChild(hdr)
      const profitColor=pf.profit>=0?'#f87171':'#34d399', dailyColor=pf.dailyProfit>=0?'#f87171':'#34d399'
      const grid=createEl('div',{class:'gm-pf-card-grid3'})
      const arrow=data?(up?'▲':'▼'):''
      grid.innerHTML=`<div class="gm-pf-cell"><div class="gm-pf-cell-lbl">当前价</div><div class="gm-pf-cell-val" style="color:${color}">${arrow} ¥${pf.current.toFixed(2)}</div></div><div class="gm-pf-cell"><div class="gm-pf-cell-lbl">市值</div><div class="gm-pf-cell-val">¥${pf.marketValue.toFixed(2)}</div></div><div class="gm-pf-cell"><div class="gm-pf-cell-lbl">日盈亏</div><div class="gm-pf-cell-val" style="color:${dailyColor}">${pf.dailyProfit>=0?'+':''}¥${pf.dailyProfit.toFixed(2)}</div></div><div class="gm-pf-cell"><div class="gm-pf-cell-lbl">成本价</div><div class="gm-pf-cell-val">${pf.costPrice>0?'¥'+pf.costPrice.toFixed(2):'--'}</div></div><div class="gm-pf-cell"><div class="gm-pf-cell-lbl">成本</div><div class="gm-pf-cell-val">¥${pf.totalCost.toFixed(2)}</div></div><div class="gm-pf-cell"><div class="gm-pf-cell-lbl">总盈亏</div><div class="gm-pf-cell-val" style="color:${profitColor}">${pf.profit>=0?'+':''}¥${pf.profit.toFixed(2)}</div></div>`
      card.appendChild(grid); rows.appendChild(card)
    })
    return rows
  }

  function render() {
    const container=document.getElementById('gm-container'); if(!container)return
    const content=container.querySelector('.gm-content'); if(!content)return
    content.innerHTML=''
    content.appendChild(renderTickerBar())
    const pf=renderPortfolioSection(); if(pf) content.appendChild(pf)
    const footer=container.querySelector('.gm-footer')
    if(footer){
      const now=new Date(), timeStr=now.toLocaleString('zh-CN',{hour12:false})
      footer.querySelector('.gm-status').textContent = STATE.loading ? '正在获取数据...' : `上次更新: ${timeStr} · 每${STATE.refreshInterval}s刷新${STATE.failCount>0?' · ⚠'+STATE.failCount+'项':''}`
    }
  }

  /* ============================================================
     UI Build
  ============================================================ */
  function buildUI() {
    if(document.getElementById('gm-root'))return
    const root=createEl('div',{id:'gm-root'})
    const container=createEl('div',{id:'gm-container'})

    const titleBar=createEl('div',{class:'gm-titlebar'})
    const titleLeft=createEl('div',{class:'gm-title-left'})
    titleLeft.appendChild(createEl('span',{class:'gm-title-text'},['积存金监测']))
    const themeBtn=createEl('span',{class:'gm-btn gm-btn-theme',title:STATE.theme==='dark'?'切换浅色':'切换深色'})
    themeBtn.textContent=STATE.theme==='dark'?'☀':'☾'
    themeBtn.addEventListener('click',toggleTheme)
    titleLeft.appendChild(themeBtn)
    titleBar.appendChild(titleLeft)
    const titleRight=createEl('div',{class:'gm-title-right'})
    const closeBtn=createEl('span',{class:'gm-btn gm-btn-close',title:'关闭面板'})
    closeBtn.textContent='×'; closeBtn.addEventListener('click',hidePanel)
    titleRight.appendChild(closeBtn); titleBar.appendChild(titleRight)
    container.appendChild(titleBar)
    container.appendChild(createEl('div',{class:'gm-content'}))

    const footer=createEl('div',{class:'gm-footer'})
    footer.appendChild(createEl('span',{class:'gm-status'},['初始化...']))
    const footerRight=createEl('div',{class:'gm-footer-right'})
    const refreshBtn=createEl('span',{class:'gm-btn gm-btn-refresh'},['⟳'])
    refreshBtn.title='立即刷新'; refreshBtn.addEventListener('click',manualRefresh)
    footerRight.appendChild(refreshBtn)
    const settingsBtn=createEl('span',{class:'gm-btn gm-btn-settings'},['⚙'])
    settingsBtn.title='设置'; settingsBtn.addEventListener('click',showSettings)
    footerRight.appendChild(settingsBtn)
    footer.appendChild(footerRight); container.appendChild(footer)
    container.appendChild(createEl('div',{class:'gm-resize'}))

    root.appendChild(container); document.body.appendChild(root)
    restorePosition(container); buildToggleBtn(); makeDraggable(container,titleBar); makeDraggable(container,container)
    STATE.initialized=true
    if(STATE.theme==='light')document.documentElement.classList.add('gm-light')
    if(STATE.hidden) hidePanel(false)
  }

  function buildToggleBtn() {
    if(document.getElementById('gm-toggle-btn'))return
    const btn=createEl('div',{id:'gm-toggle-btn',title:'拖拽移动 · 点击展开面板'})
    btn.appendChild(createEl('span',{class:'gm-toggle-icon'}))
    btn.appendChild(createEl('span',{class:'gm-toggle-name'}))
    btn.appendChild(createEl('span',{class:'gm-toggle-value'},['--']))
    btn.addEventListener('click',showPanel)
    document.body.appendChild(btn); makeDraggable(btn,btn,true); restoreTogglePos(btn)
    STATE._toggleIcon=btn.querySelector('.gm-toggle-icon')
  }
  function restoreTogglePos(btn){const p=STATE.pos;if(p?.toggleLeft)btn.style.left=p.toggleLeft;if(p?.toggleTop)btn.style.top=p.toggleTop;if(p?.toggleRight)btn.style.right=p.toggleRight}

  /* ============================================================
     Drag & Resize
  ============================================================ */
  function makeDraggable(el,handle,delayClick){
    let x1=0,y1=0,x2=0,y2=0,dragged=false
    handle.addEventListener('mousedown',(e)=>{
      if(e.target.closest('.gm-title-right')||e.target.closest('.gm-btn'))return
      dragged=false;x1=e.clientX;y1=e.clientY;const rect=el.getBoundingClientRect();x2=rect.left;y2=rect.top
      const onMove=(ev)=>{ev.preventDefault();const dx=ev.clientX-x1,dy=ev.clientY-y1;if(Math.abs(dx)>3||Math.abs(dy)>3)dragged=true;el.style.left=x2+dx+'px';el.style.top=y2+dy+'px';el.style.right='auto';el.style.bottom='auto'}
      const onUp=()=>{document.removeEventListener('mousemove',onMove);document.removeEventListener('mouseup',onUp);if(dragged)savePosition()}
      document.addEventListener('mousemove',onMove);document.addEventListener('mouseup',onUp)
    })
    handle.addEventListener('dragstart',(e)=>e.preventDefault())
    if(delayClick) handle.addEventListener('click',(e)=>{if(dragged){e.stopImmediatePropagation();return}},true)
  }
  function restorePosition(el){const p=STATE.pos;if(!p||(!p.left&&!p.right)){el.style.top='80px';el.style.right='20px';return}if(p.left)el.style.left=p.left;if(p.top)el.style.top=p.top;if(p.right)el.style.right=p.right}

  /* ============================================================
     Actions
  ============================================================ */
  function getHeldBankKeys(){return CONFIG.banks.filter(b=>{const h=getHolding(b.key);return h.g>0&&h.c>0})}

  function hidePanel(saveState=true){STATE.hidden=true;if(saveState)GM_setValue('hidden',true);const root=document.getElementById('gm-root');if(root)root.style.display='none';const btn=document.getElementById('gm-toggle-btn');if(btn)btn.style.display='flex';refreshToggleBanks();STATE.toggleIdx=0;updateToggleDisplay();startToggleCycle()}
  function showPanel(){STATE.hidden=false;GM_setValue('hidden',false);const root=document.getElementById('gm-root');if(root)root.style.display='block';const btn=document.getElementById('gm-toggle-btn');if(btn)btn.style.display='none';stopToggleCycle();render()}
  function togglePanel(){const root=document.getElementById('gm-root');if(root&&root.style.display!=='none')hidePanel();else showPanel()}
  function refreshToggleBanks(){const held=getHeldBankKeys().map(b=>b.key);STATE.toggleBankKeys=['jd','gj',...held];if(STATE.toggleBankKeys.length===3)STATE.toggleBankKeys=['jd','gj','ms','zs','cib','icbc','cmb','cgb','abc','ccb','boc'];STATE.toggleIdx=Math.min(STATE.toggleIdx,STATE.toggleBankKeys.length-1)}
  function startToggleCycle(){stopToggleCycle();if(STATE.toggleBankKeys.length<=1)return;STATE.toggleTimer=setInterval(()=>{STATE.toggleIdx=(STATE.toggleIdx+1)%STATE.toggleBankKeys.length;updateToggleDisplay()},STATE.cycleSeconds*1000)}
  function stopToggleCycle(){if(STATE.toggleTimer){clearInterval(STATE.toggleTimer);STATE.toggleTimer=null}}
  function updateToggleDisplay(){
    const btn=document.getElementById('gm-toggle-btn');if(!btn||btn.style.display==='none')return
    const iconEl=btn.querySelector('.gm-toggle-icon'),nameEl=btn.querySelector('.gm-toggle-name'),valEl=btn.querySelector('.gm-toggle-value')
    if(!nameEl||!valEl)return
    const keys=STATE.toggleBankKeys
    if(!keys||keys.length===0){const p=STATE.prices['ms']||STATE.prices['zs']||STATE.prices['cib'];if(iconEl)iconEl.textContent='💰';nameEl.textContent='金价';const color=p?(p.change>=0?'#f87171':'#34d399'):'#6b7280';valEl.textContent=p?`¥${p.price.toFixed(2)}`:'--';valEl.style.color=color;return}
    const idx=Math.min(STATE.toggleIdx,keys.length-1),key=keys[idx]
    const bank=CONFIG.banks.find(b=>b.key===key),tick=CONFIG.ticker.find(t=>t.key===key),item=bank||tick,data=STATE.prices[key]
    if(item&&data){const color=data.change>=0?'#f87171':'#34d399';if(iconEl)iconEl.innerHTML=logoHTML(item);nameEl.textContent=tick?item.name:shortName(item.name);const prefix=(item.currency||'¥')==='$'?'$':'¥';valEl.textContent=`${prefix}${data.price.toFixed(2)}`;valEl.style.color=color}
    else if(item){if(iconEl)iconEl.innerHTML=logoHTML(item);nameEl.textContent=tick?item.name:shortName(item.name);valEl.textContent='--';valEl.style.color='#6b7280'}
  }
  function manualRefresh(){const btn=document.querySelector('.gm-btn-refresh');if(btn)btn.style.animation='gmSpin 0.6s linear';refreshAllPrices()}
  function toggleTheme(){
    STATE.theme=STATE.theme==='dark'?'light':'dark'
    GM_setValue('theme',STATE.theme)
    document.documentElement.classList.toggle('gm-light',STATE.theme==='light')
    const btn=document.querySelector('.gm-btn-theme')
    if(btn){btn.textContent=STATE.theme==='dark'?'☀':'☾';btn.title=STATE.theme==='dark'?'切换浅色':'切换深色'}
  }

  /* ============================================================
     Settings Panel with Alert Config
  ============================================================ */
  function showSettings() {
    const overlay = createEl('div', { class: 'gm-overlay', style: { display: 'flex' } })
    const panel = createEl('div', { class: 'gm-settings' })
    panel.appendChild(createEl('div', { class: 'gm-settings-title' }, ['设置']))
    const body = createEl('div', { class: 'gm-settings-body' })

    /* --- Interval --- */
    const intervalRow = createEl('div', { class: 'gm-settings-row' })
    const grp1 = createEl('div', { class: 'gm-interval-group' })
    grp1.appendChild(createEl('label', { class: 'gm-settings-label' }, ['刷新间隔（秒）']))
    const input = createEl('input', { type: 'number', class: 'gm-settings-input gm-input-flex', value: STATE.refreshInterval, min: CONFIG.minRefresh, max: CONFIG.maxRefresh })
    grp1.appendChild(input); intervalRow.appendChild(grp1)
    const grp2 = createEl('div', { class: 'gm-interval-group' })
    grp2.appendChild(createEl('label', { class: 'gm-settings-label' }, ['悬浮球间隔（秒）']))
    const cycleInput = createEl('input', { type: 'number', class: 'gm-settings-input gm-input-flex', value: STATE.cycleSeconds, min: 3, max: 60 })
    grp2.appendChild(cycleInput); intervalRow.appendChild(grp2)
    body.appendChild(intervalRow)

    /* --- Holdings --- */
    const holdTitle = createEl('div', { class: 'gm-settings-group' })
    holdTitle.style.cssText = 'border-top:1px solid #eee;padding-top:8px'
    holdTitle.appendChild(createEl('label', { class: 'gm-settings-label gm-settings-subtitle' }, ['📦 我的持仓']))
    body.appendChild(holdTitle)

    const holdingsListEl = createEl('div', { class: 'gm-alert-list' })
    const holdingRows = []
    function renderHoldingRows() {
      holdingsListEl.innerHTML = ''
      holdingRows.length = 0
      const keys = Object.keys(STATE.holdings).filter(k => STATE.holdings[k].g > 0 || STATE.holdings[k].c > 0)
      keys.forEach(key => {
        const h = STATE.holdings[key]
        const bank = CONFIG.banks.find(b => b.key === key)
        if (!bank) return
        const row = createEl('div', { class: 'gm-alert-row' })
        const nameSpan = createEl('span', { class: 'gm-alert-target' })
        nameSpan.innerHTML = `${logoHTML(bank)}<span>${bank.name}</span>`
        row.appendChild(nameSpan)
        const gInp = createEl('input', { type: 'number', step: '0.01', min: '0', class: 'gm-settings-input gm-input-sm', placeholder: '克数', value: h.g > 0 ? h.g : '' })
        const cInp = createEl('input', { type: 'number', step: '0.01', min: '0', class: 'gm-settings-input gm-input-sm', placeholder: '成本价', value: h.c > 0 ? h.c : '' })
        row.appendChild(gInp)
        row.appendChild(createEl('span', { class: 'gm-hl-unit' }, ['g']))
        row.appendChild(cInp)
        row.appendChild(createEl('span', { class: 'gm-hl-unit' }, ['元/g']))
        const delBtn = createEl('span', { class: 'gm-alert-del' }, ['✕'])
        delBtn.addEventListener('click', () => {
          STATE.holdings[key] = { g: 0, c: 0 }
          saveHoldings()
          renderHoldingRows()
        })
        row.appendChild(delBtn)
        holdingsListEl.appendChild(row)
        holdingRows.push({ key, gInp, cInp })
      })
    }
    renderHoldingRows()
    body.appendChild(holdingsListEl)

    const holdAddForm = createEl('div', { class: 'gm-alert-add' })
    const holdBankSelect = createCustomSelect(CONFIG.banks.map(b => ({ value: b.key, name: b.name, logo: b.logo })))
    holdAddForm.appendChild(holdBankSelect)
    const holdGInp = createEl('input', { type: 'number', step: '0.01', min: '0', class: 'gm-settings-input gm-input-sm', placeholder: '克数', style: { width: '60px' } })
    const holdCInp = createEl('input', { type: 'number', step: '0.01', min: '0', class: 'gm-settings-input gm-input-sm', placeholder: '成本价', style: { width: '70px' } })
    const holdBtnAdd = createEl('span', { class: 'gm-btn gm-btn-primary', style: { padding: '6px 12px', fontSize: '11px' } }, ['添加'])
    holdBtnAdd.addEventListener('click', () => {
      const g = parseFloat(holdGInp.value) || 0
      const c = parseFloat(holdCInp.value) || 0
      if (g <= 0 && c <= 0) { showToast('请维护克数或成本价后再添加', overlay); return }
      const key = holdBankSelect.value
      const existing = STATE.holdings[key]
      if (existing && (existing.g > 0 || existing.c > 0)) {
        const bank = CONFIG.banks.find(b => b.key === key)
        showToast(`已维护${bank ? bank.name : key}的数据，请在原数据上修改`, overlay)
        return
      }
      STATE.holdings[key] = { g, c }
      saveHoldings()
      renderHoldingRows()
      holdGInp.value = ''; holdCInp.value = ''
    })
    holdAddForm.appendChild(holdGInp); holdAddForm.appendChild(holdCInp); holdAddForm.appendChild(holdBtnAdd)
    body.appendChild(holdAddForm)

    /* --- Price Alerts --- */
    const alertTitle = createEl('div', { class: 'gm-settings-group' })
    alertTitle.style.cssText = 'border-top:1px solid #eee;padding-top:8px'
    alertTitle.appendChild(createEl('label', { class: 'gm-settings-label gm-settings-subtitle' }, ['🔔 价格提醒']))
    body.appendChild(alertTitle)

    const alertListEl = createEl('div', { class: 'gm-alert-list' })
    const allTargets = [...CONFIG.banks, ...CONFIG.ticker]

    function renderAlertRows() {
      alertListEl.innerHTML = ''
      STATE.alerts.forEach((alert, idx) => {
        const row = createEl('div', { class: 'gm-alert-row' })
        const target = allTargets.find(t => t.key === alert.bankKey)
        const targetName = target ? target.name : alert.bankKey
        const prefix = (target?.currency || '¥') === '$' ? '$' : '¥'

        row.innerHTML = `
          <span class="gm-alert-target">${target ? logoHTML(target) : ''}<span>${targetName}</span></span>
          <span class="gm-alert-dir ${alert.type === 'up' ? 'gm-alert-up' : 'gm-alert-down'}">${alert.type === 'up' ? '≥' : '≤'}</span>
          <span class="gm-alert-price">${prefix}${alert.price.toFixed(2)}</span>
          <label class="gm-alert-toggle"><input type="checkbox" ${alert.enabled ? 'checked' : ''} data-idx="${idx}"></label>
          <span class="gm-alert-del" data-idx="${idx}">✕</span>
        `
        alertListEl.appendChild(row)
      })

      alertListEl.querySelectorAll('.gm-alert-toggle input').forEach(cb => {
        cb.addEventListener('change', (e) => {
          const i = parseInt(e.target.dataset.idx)
          STATE.alerts[i].enabled = e.target.checked
          saveAlerts()
        })
      })
      alertListEl.querySelectorAll('.gm-alert-del').forEach(btn => {
        btn.addEventListener('click', (e) => {
          const i = parseInt(e.target.dataset.idx)
          STATE.alerts.splice(i, 1)
          saveAlerts()
          renderAlertRows()
        })
      })
    }
    renderAlertRows()
    body.appendChild(alertListEl)

    const addForm = createEl('div', { class: 'gm-alert-add' })
    const bankSelect = createCustomSelect([...CONFIG.banks, ...CONFIG.ticker].map(t => ({ value: t.key, name: t.name, logo: t.logo })))
    addForm.appendChild(bankSelect)
    const selDir = createEl('select', { class: 'gm-settings-input', style: { width: '60px', flex: 'none' } })
    selDir.appendChild(createEl('option', { value: 'up' }, ['≥']))
    selDir.appendChild(createEl('option', { value: 'down' }, ['≤']))
    const inpPrice = createEl('input', { type: 'number', step: '0.01', min: '0', class: 'gm-settings-input gm-input-sm', placeholder: '价格', style: { width: '80px', flex: 'none' } })
    const btnAdd = createEl('span', { class: 'gm-btn gm-btn-primary', style: { padding: '6px 12px', fontSize: '11px' } }, ['添加'])
    btnAdd.addEventListener('click', () => {
      const price = parseFloat(inpPrice.value)
      if (isNaN(price) || price <= 0) { showToast('请维护目标价格后再添加', overlay); inpPrice.focus(); return }
      const key = bankSelect.value
      const type = selDir.value
      if (STATE.alerts.some(a => a.bankKey === key && a.type === type)) {
        const target = allTargets.find(t => t.key === key)
        showToast(`已维护${target ? target.name : key}的${type === 'up' ? '上涨' : '下跌'}提醒，请在原数据上修改`, overlay)
        return
      }
      STATE.alerts.push({
        id: Date.now().toString(36),
        bankKey: bankSelect.value,
        type: selDir.value,
        price: price,
        enabled: true,
        lastTriggered: 0
      })
      saveAlerts()
      renderAlertRows()
      inpPrice.value = ''
    })
    addForm.appendChild(selDir); addForm.appendChild(inpPrice); addForm.appendChild(btnAdd)
    body.appendChild(addForm)

    /* --- Save Button --- */
    const saveAllBtn = createEl('div', { class: 'gm-settings-group' })
    saveAllBtn.style.cssText = 'border-top:1px solid #eee;padding-top:8px;align-items:flex-end'
    const btnWrap = createEl('div', { class: 'gm-input-group' })
    const holdSaveBtn = createEl('span', { class: 'gm-btn gm-btn-primary' }, ['保存持仓与设置'])
    holdSaveBtn.addEventListener('click', () => {
      let rv = parseInt(input.value, 10); if (isNaN(rv) || rv < CONFIG.minRefresh) rv = CONFIG.minRefresh; if (rv > CONFIG.maxRefresh) rv = CONFIG.maxRefresh
      input.value = rv; if (rv !== STATE.refreshInterval) { STATE.refreshInterval = rv; GM_setValue('refreshInterval', rv); restartTimer() }
      let cv = parseInt(cycleInput.value, 10); if (isNaN(cv) || cv < 3) cv = 3; if (cv > 60) cv = 60
      cycleInput.value = cv; if (cv !== STATE.cycleSeconds) { STATE.cycleSeconds = cv; GM_setValue('cycleSeconds', cv); if (STATE.hidden) { stopToggleCycle(); startToggleCycle() } }
      holdingRows.forEach(({ key, gInp, cInp }) => {
        const g = parseFloat(gInp.value) || 0, c = parseFloat(cInp.value) || 0
        STATE.holdings[key] = { g: Math.max(0, g), c: Math.max(0, c) }
      })
      saveHoldings(); render(); overlay.remove()
    })
    btnWrap.appendChild(holdSaveBtn); saveAllBtn.appendChild(btnWrap); body.appendChild(saveAllBtn)

    /* --- Info --- */
    const groupInfo = createEl('div', { class: 'gm-settings-group gm-info-text' })
    groupInfo.style.cssText = 'font-size:12px;color:#888;line-height:1.6'
    groupInfo.innerHTML = '数据来源: 京东金融 / 招商银行<br>接口限流: 2次/秒/IP · 失败自动重试1次<br>缓存: 接口失败时沿用上次数据(标记⚠)<br>提醒冷却: 同规则5分钟内不重复通知'
    body.appendChild(groupInfo)

    panel.appendChild(body)
    const closeX = createEl('span', { class: 'gm-btn gm-btn-close', style: { position: 'absolute', top: '8px', right: '12px', fontSize: '20px' } })
    closeX.textContent = '×'; closeX.addEventListener('click', () => overlay.remove())
    panel.appendChild(closeX)
    overlay.appendChild(panel)
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove() })
    document.body.appendChild(overlay)
  }

  function restartTimer() { if (STATE.timerId) clearInterval(STATE.timerId); startTimers() }
  function startTimers() { fetchAll(); STATE.timerId = setInterval(fetchAll, STATE.refreshInterval * 1000) }
  async function fetchAll() { await refreshAllPrices() }

  /* ============================================================
     Styles (Enhanced with Alert CSS)
  ============================================================ */
  GM_addStyle(`
    :root{--gm-bg:#12141a;--gm-card:#1a1d25;--gm-card-hover:#20232d;--gm-border:#262a35;--gm-border-light:#1e2230;--gm-text-1:#ece8e0;--gm-text-2:#9a9490;--gm-text-3:#6b6665;--gm-accent:#d4a74a;--gm-accent-bg:rgba(212,167,74,0.08);--gm-accent-glow:rgba(212,167,74,0.15);--gm-up:#f87171;--gm-down:#34d399;--gm-radius:16px;--gm-radius-sm:10px;--gm-shadow:0 4px 24px rgba(0,0,0,0.5),0 0 0 1px rgba(212,167,74,0.04);--gm-shadow-hover:0 6px 32px rgba(0,0,0,0.6),0 0 0 1px rgba(212,167,74,0.08);--gm-font:"SF Pro Display",-apple-system,BlinkMacSystemFont,"Inter","Noto Sans SC",sans-serif}
    .gm-light{--gm-bg:#F7F9FC;--gm-card:#FFFFFF;--gm-card-hover:#F0F2F5;--gm-border:#E2E8F0;--gm-border-light:#E8EDF2;--gm-text-1:#1A2436;--gm-text-2:#374151;--gm-text-3:#6B778C;--gm-accent:#B88638;--gm-accent-bg:rgba(184,134,56,0.08);--gm-up:#E05050;--gm-down:#34d399;--gm-shadow:0 2px 12px rgba(0,0,0,0.06),0 0 0 1px rgba(0,0,0,0.03);--gm-shadow-hover:0 4px 16px rgba(0,0,0,0.1),0 0 0 1px rgba(0,0,0,0.04)}
    .gm-light #gm-container{box-shadow:var(--gm-shadow);border-color:var(--gm-border)}
    .gm-light .gm-pf-summary{border-color:rgba(184,134,56,0.12)}
    #gm-root{position:fixed;z-index:2147483647;font-family:var(--gm-font);font-size:13px;line-height:1.5;color:var(--gm-text-1);user-select:none;-webkit-font-smoothing:antialiased}
    #gm-container{position:fixed;top:80px;right:20px;width:368px;background:var(--gm-bg);border-radius:var(--gm-radius);box-shadow:var(--gm-shadow),inset 0 1px 0 rgba(212,167,74,0.06);border:1px solid var(--gm-border);overflow:hidden;transition:all .3s cubic-bezier(.4,0,.2,1)}
    .gm-titlebar{display:flex;align-items:center;justify-content:space-between;padding:12px 16px;background:var(--gm-card);border-bottom:1px solid var(--gm-border);cursor:move}
    .gm-title-left{display:flex;align-items:center;gap:8px}
    .gm-title-text{font-weight:700;font-size:14px;letter-spacing:.5px;color:var(--gm-accent)}
    .gm-title-right{display:flex;gap:2px}
    .gm-btn{cursor:pointer;padding:5px 8px;border-radius:6px;transition:all .2s ease;font-size:14px;line-height:1;color:var(--gm-text-3)}
    .gm-btn:hover{background:var(--gm-card-hover);color:var(--gm-text-1)}
    .gm-btn-close:hover{background:rgba(248,113,113,0.12);color:var(--gm-up)}
    .gm-btn-primary{background:linear-gradient(135deg,#d4a74a,#c4953a);color:#12141a;padding:8px 20px;border-radius:8px;font-size:12px;font-weight:700;cursor:pointer;border:none;transition:all .2s ease}
    .gm-btn-primary:hover{background:linear-gradient(135deg,#e0b55a,#d4a74a);box-shadow:0 0 20px rgba(212,167,74,0.3);transform:translateY(-1px)}
    .gm-content{padding:10px;max-height:500px;overflow-y:auto}
    .gm-content::-webkit-scrollbar{width:4px}
    .gm-content::-webkit-scrollbar-thumb{background:#2a2e3a;border-radius:4px}
    .gm-light .gm-content::-webkit-scrollbar-thumb{background:#c0b8a8}
    .gm-light .gm-settings-input{background:#F2F6FB}
    .gm-light .gm-settings-input:focus{border-color:#B88638;box-shadow:0 0 0 2px rgba(184,134,56,0.12)}
    .gm-light .gm-btn-primary{background:#D4A048;color:#FFF;box-shadow:none}
    .gm-light .gm-btn-primary:hover{background:#E6C278;color:#FFF;box-shadow:none;transform:translateY(-1px)}
    .gm-light .gm-pf-card-hold{background:#FCF7E9!important;color:#B88638!important}
    .gm-light .gm-cs-option:hover{background:rgba(184,134,56,0.1);color:#1A2436}
    .gm-light .gm-cs-option.selected{color:#B88638}
    .gm-light .gm-alert-toggle input{accent-color:#D4A048}
    .gm-light .gm-alert-add select{background:#F2F6FB url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6'%3E%3Cpath d='M0 0l5 6 5-6z' fill='%236B778C'/%3E%3C/svg%3E") no-repeat right 8px center}
    .gm-light .gm-cs-trigger{background:#F2F6FB}
    .gm-light .gm-info-text{color:#86909C!important}
    .gm-light .gm-settings-hl-row:hover{background:rgba(0,0,0,0.02)}
    .gm-ticker-bar{width:100%;overflow-x:auto;overflow-y:hidden;scrollbar-width:none;background:var(--gm-card);border-radius:var(--gm-radius-sm);border:1px solid var(--gm-border);margin-bottom:10px}
    .gm-ticker-bar::-webkit-scrollbar{display:none}
    .gm-ticker-wrap{display:flex;padding:8px 0;width:max-content;animation:gmTickerScroll 25s linear infinite}
    .gm-ticker-wrap:hover{animation-play-state:paused}
    .gm-ticker-item{display:flex;align-items:center;gap:6px;padding:4px 14px;border-right:1px solid var(--gm-border);white-space:nowrap;flex-shrink:0}
    .gm-ticker-item:last-child{border-right:none}
    .gm-ticker-icon{font-size:12px;display:inline-flex;align-items:center}
    .gm-bank-logo{width:14px;height:14px;border-radius:3px;vertical-align:middle;opacity:.85}
    .gm-pf-card-header .gm-bank-logo{width:16px;height:16px;border-radius:4px}
    .gm-ticker-name{font-size:10px;font-weight:600;color:var(--gm-text-3);letter-spacing:.3px}
    .gm-ticker-price{font-size:13px;font-weight:700;font-variant-numeric:tabular-nums;letter-spacing:-.2px}
    .gm-ticker-arrow{font-size:9px;line-height:1}
    .gm-ticker-empty{padding:10px 14px;font-size:12px;color:var(--gm-text-3)}
    @keyframes gmTickerScroll{0%{transform:translateX(0)}100%{transform:translateX(-50%)}}
    .gm-pf-section{max-height:340px;overflow-y:auto}
    .gm-pf-section::-webkit-scrollbar{width:4px}
    .gm-pf-section::-webkit-scrollbar-thumb{background:#2a2e3a;border-radius:4px}
    .gm-light .gm-pf-section::-webkit-scrollbar-thumb{background:#c0b8a8}
    .gm-pf-summary{padding:12px 16px;background:var(--gm-accent-bg);border-radius:var(--gm-radius-sm);border:1px solid rgba(212,167,74,0.06);margin-bottom:10px}
    .gm-pf-summary-title{font-weight:700;font-size:13px;color:var(--gm-accent);margin-bottom:10px;letter-spacing:.3px}
    .gm-pf-summary-grid{display:grid;grid-template-columns:1fr 1fr 1fr;gap:4px 6px;font-size:11px;color:var(--gm-text-2)}
    .gm-pf-cell{text-align:center}
    .gm-pf-cell-lbl{font-size:9px;color:var(--gm-text-3);letter-spacing:.5px;margin-bottom:2px}
    .gm-pf-cell-val{font-weight:700;color:var(--gm-text-1);font-variant-numeric:tabular-nums;font-size:13px;letter-spacing:-.2px}
    .gm-pf-card{padding:12px 16px;background:var(--gm-card);border-radius:var(--gm-radius-sm);border:1px solid var(--gm-border);margin-bottom:8px;transition:all .2s ease}
    .gm-pf-card:last-child{margin-bottom:0}
    .gm-pf-card:hover{background:var(--gm-card-hover);box-shadow:var(--gm-shadow-hover)}
    .gm-pf-card-header{display:flex;justify-content:space-between;align-items:center;font-size:13px;font-weight:700;color:var(--gm-text-1)}
    .gm-pf-card-name{display:flex;align-items:center;gap:6px}
    .gm-pf-card-hold{font-size:10px;padding:2px 10px;border-radius:20px;background:var(--gm-accent-bg);color:var(--gm-accent);font-weight:600;letter-spacing:.2px}
    .gm-pf-card-grid3{display:grid;grid-template-columns:1fr 1fr 1fr;gap:0 4px;margin:8px 0 0}
    .gm-pf-card-grid3 .gm-pf-cell{text-align:center}
    .gm-pf-card-grid3 .gm-pf-cell-lbl{font-size:9px;color:var(--gm-text-3);letter-spacing:.3px;margin-bottom:1px}
    .gm-pf-card-grid3 .gm-pf-cell-val{font-weight:700;font-variant-numeric:tabular-nums;font-size:12px;letter-spacing:-.2px}
    .gm-footer{display:flex;align-items:center;justify-content:space-between;padding:9px 16px;background:var(--gm-card);border-top:1px solid var(--gm-border);font-size:10px;color:var(--gm-text-3)}
    .gm-footer-right{display:flex;gap:4px}
    .gm-overlay{position:fixed;inset:0;background:rgba(0,0,0,0.65);backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);z-index:2147483647;display:none;align-items:center;justify-content:center;animation:gmFadeIn .2s ease}
    .gm-settings{position:relative;background:var(--gm-card);border-radius:var(--gm-radius);padding:20px 24px 22px;width:380px;max-height:85vh;overflow-y:auto;box-shadow:0 20px 60px rgba(0,0,0,0.6);border:1px solid var(--gm-border)}
    .gm-settings::-webkit-scrollbar{width:4px}
    .gm-settings::-webkit-scrollbar-thumb{background:#2a2e3a;border-radius:4px}
    .gm-light .gm-settings::-webkit-scrollbar-thumb{background:#c0b8a8}
    .gm-settings-title{font-size:16px;font-weight:800;margin-bottom:16px;color:var(--gm-text-1);letter-spacing:-.2px}
    .gm-settings-body{display:flex;flex-direction:column;gap:10px}
    .gm-settings-group{display:flex;flex-direction:column;gap:4px}
    .gm-settings-row{display:flex;align-items:center;gap:8px}
    .gm-interval-group{flex:1;display:flex;align-items:center;gap:6px;min-width:0}
    .gm-settings-label{font-size:12px;font-weight:500;color:var(--gm-text-2);white-space:nowrap}
    .gm-settings-subtitle{font-size:13px;font-weight:700;color:var(--gm-text-1)}
    .gm-input-group{display:flex;gap:6px;align-items:center}
    .gm-settings-input{height:30px;padding:0 10px;border:1px solid var(--gm-border);border-radius:8px;font-size:13px;outline:none;transition:all .2s ease;box-sizing:border-box;background:var(--gm-bg);color:var(--gm-text-1)}
    .gm-input-flex{flex:1;min-width:0}
    .gm-settings-input:focus{border-color:var(--gm-accent);box-shadow:0 0 0 2px rgba(212,167,74,0.12)}
    .gm-settings-input::-webkit-outer-spin-button,.gm-settings-input::-webkit-inner-spin-button{-webkit-appearance:none;margin:0}
    .gm-settings-input[type='number']{-moz-appearance:textfield}
    .gm-settings-hl-row{display:flex;align-items:center;padding:6px 10px;border-radius:8px;transition:background .15s ease}
    .gm-settings-hl-row:hover{background:rgba(255,255,255,0.03)}
    .gm-settings-hl-name+.gm-input-sm{margin-left:10px}
    .gm-hl-unit+.gm-input-sm{margin-left:10px}
    .gm-hl-unit{margin:0 0 0 4px;font-size:10px;line-height:1;color:var(--gm-text-3);white-space:nowrap;flex-shrink:0}
    .gm-settings-hl-name{width:70px;font-size:12px;font-weight:500;color:var(--gm-text-2);flex-shrink:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;display:flex;align-items:center;gap:5px;line-height:1}
    .gm-settings-hl-name .gm-bank-logo{width:14px;height:14px;border-radius:3px;flex-shrink:0}
    .gm-input-sm{width:74px;height:28px;padding:0 8px!important;font-size:12px!important;flex:none;box-sizing:border-box}
    .gm-input-sm::-webkit-outer-spin-button,.gm-input-sm::-webkit-inner-spin-button{-webkit-appearance:none;margin:0}
    .gm-input-sm[type='number']{-moz-appearance:textfield}

    .gm-alert-list{display:flex;flex-direction:column;gap:4px;max-height:150px;overflow-y:auto}
    .gm-alert-list::-webkit-scrollbar{width:3px}
    .gm-alert-list::-webkit-scrollbar-thumb{background:#2a2e3a;border-radius:3px}
    .gm-light .gm-alert-list::-webkit-scrollbar-thumb{background:#c0b8a8}
    .gm-alert-row{display:flex;align-items:center;gap:6px;padding:6px 10px;border-radius:8px;background:var(--gm-card);border:1px solid var(--gm-border);font-size:12px}
    .gm-alert-target{flex:1;font-weight:600;color:var(--gm-text-2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;display:flex;align-items:center;gap:5px}
    .gm-alert-dir{font-weight:800;font-size:13px;width:20px;text-align:center}
    .gm-alert-up{color:var(--gm-up)}
    .gm-alert-down{color:var(--gm-down)}
    .gm-alert-price{font-weight:700;font-variant-numeric:tabular-nums;color:var(--gm-text-1);min-width:60px;text-align:right}
    .gm-alert-toggle input{accent-color:var(--gm-accent);cursor:pointer}
    .gm-alert-del{cursor:pointer;color:var(--gm-text-3);font-size:11px;padding:2px 4px;border-radius:4px;transition:all .15s}
    .gm-alert-del:hover{background:rgba(248,113,113,0.15);color:var(--gm-up)}
    .gm-alert-add{display:flex;align-items:center;gap:6px;padding:8px 0}
    .gm-alert-add select{appearance:none;background:var(--gm-bg) url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6'%3E%3Cpath d='M0 0l5 6 5-6z' fill='%236b6665'/%3E%3C/svg%3E") no-repeat right 8px center;padding-right:22px}

    .gm-custom-select{position:relative;flex:1;min-width:0}
    .gm-cs-trigger{display:flex;align-items:center;gap:6px;height:30px;padding:0 10px;border:1px solid var(--gm-border);border-radius:8px;background:var(--gm-bg);color:var(--gm-text-1);font-size:13px;cursor:pointer;transition:border-color .2s;white-space:nowrap;overflow:hidden}
    .gm-cs-trigger:hover,.gm-cs-trigger.active{border-color:var(--gm-accent)}
    .gm-cs-trigger .gm-bank-logo{width:14px;height:14px;border-radius:3px;flex-shrink:0}
    .gm-cs-trigger::after{content:'▾';margin-left:auto;font-size:10px;color:var(--gm-text-3);flex-shrink:0}
    .gm-cs-dropdown{position:absolute;top:calc(100% + 4px);left:0;right:0;max-height:200px;overflow-y:auto;background:var(--gm-card);border:1px solid var(--gm-border);border-radius:8px;box-shadow:0 8px 24px rgba(0,0,0,0.5);z-index:10;display:none}
    .gm-cs-dropdown.open{display:block}
    .gm-cs-option{display:flex;align-items:center;gap:6px;padding:7px 10px;font-size:12px;color:var(--gm-text-2);cursor:pointer;transition:background .15s}
    .gm-cs-option:hover{background:rgba(212,167,74,0.1);color:var(--gm-text-1)}
    .gm-cs-option.selected{color:var(--gm-accent);font-weight:600}
    .gm-cs-option .gm-bank-logo{width:14px;height:14px;border-radius:3px;flex-shrink:0}
    .gm-cs-dropdown::-webkit-scrollbar{width:3px}
    .gm-cs-dropdown::-webkit-scrollbar-thumb{background:#2a2e3a;border-radius:3px}
    .gm-light .gm-cs-dropdown::-webkit-scrollbar-thumb{background:#c0b8a8}
    .gm-toast{position:absolute;top:50%;left:50%;transform:translate(-50%,-50%) translateY(10px);background:#d4a74a;color:#12141a;padding:10px 24px;border-radius:8px;font-size:13px;font-weight:600;z-index:10;opacity:0;transition:all .3s ease;pointer-events:none;white-space:nowrap;box-shadow:0 4px 16px rgba(0,0,0,0.4)}
    .gm-toast.gm-toast-in{opacity:1;transform:translate(-50%,-50%) translateY(0)}

    #gm-toggle-btn{position:fixed;top:80px;right:20px;z-index:2147483647;display:none;align-items:center;gap:6px;padding:8px 16px;background:var(--gm-card);backdrop-filter:blur(20px);-webkit-backdrop-filter:blur(20px);border-radius:30px;box-shadow:0 4px 20px rgba(0,0,0,0.5),0 0 0 1px rgba(212,167,74,0.06);border:1px solid var(--gm-border);cursor:pointer;font-family:var(--gm-font);font-size:13px;user-select:none;transition:all .25s cubic-bezier(.4,0,.2,1)}
    #gm-toggle-btn:hover{transform:scale(1.03) translateY(-1px);box-shadow:0 8px 30px rgba(0,0,0,0.6),0 0 0 1px rgba(212,167,74,0.12)}
    .gm-toggle-icon{font-size:14px;width:26px;height:26px;display:flex;align-items:center;justify-content:center;flex-shrink:0}
    .gm-toggle-icon .gm-bank-logo{width:18px;height:18px;border-radius:4px}
    .gm-toggle-name{font-weight:600;color:var(--gm-text-3);font-size:11px}
    .gm-toggle-value{font-weight:700;font-size:14px;font-variant-numeric:tabular-nums;letter-spacing:-.2px;transition:color .3s ease}
    @keyframes gmFadeIn{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:translateY(0)}}
    @keyframes gmSpin{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}
  `)

  /* ============================================================
     Menu Commands
  ============================================================ */
  GM_registerMenuCommand('📊 切换显示面板 (Alt+G)', () => togglePanel())
  GM_registerMenuCommand('⟳ 手动刷新数据', () => manualRefresh())
  GM_registerMenuCommand('⚙ 设置持仓和提醒', () => showSettings())

  /* ============================================================
     Init
  ============================================================ */
  function init() {
    if (document.readyState === 'loading') { document.addEventListener('DOMContentLoaded', init); return }
    if (STATE.initialized) return
    buildUI(); startTimers()
    document.addEventListener('keydown', (e) => { if (e.altKey && e.key === 'g') { e.preventDefault(); togglePanel() } })
  }
  init()
})()
