/*
  玄穹·问道
  纯前端修仙 Roguelite + 轻放置
  - 离线可玩（本地存档）
  - 秘境事件链（可选择）
  - 突破概率模型（多变量）
  - 功法玄图（小型技能树）
  - 炼丹/炼器（配方与品质）
*/

(() => {
  'use strict';

  /*** Utilities ***/
  const $ = (q) => document.querySelector(q);
  const $$ = (q) => Array.from(document.querySelectorAll(q));
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const lerp = (a, b, t) => a + (b - a) * t;
  const fmt = (n) => {
    if (!Number.isFinite(n)) return '0';
    if (n < 1000) return String(Math.floor(n));
    const units = [ ['K',1e3], ['M',1e6], ['B',1e9], ['T',1e12] ];
    for (let i=units.length-1;i>=0;i--){
      const [u, base] = units[i];
      if (n >= base) return (n/base).toFixed(n>=base*10?1:2).replace(/\.0+$/,'') + u;
    }
    return String(Math.floor(n));
  };
  const now = () => performance.now();

  // Deterministic PRNG with seed (Mulberry32)
  function mulberry32(seed){
    let a = seed >>> 0;
    return function(){
      a |= 0; a = a + 0x6D2B79F5 | 0;
      let t = Math.imul(a ^ a >>> 15, 1 | a);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }

  function hashCode(str){
    let h = 2166136261;
    for (let i=0;i<str.length;i++){
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }

  /*** Audio (tiny synth) ***/
  let audioCtx = null;
  let soundOn = true;

  function beep(type='sine', freq=440, dur=0.08, gain=0.03){
    if (!soundOn) return;
    try{
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      const t0 = audioCtx.currentTime;
      const osc = audioCtx.createOscillator();
      const g = audioCtx.createGain();
      osc.type = type;
      osc.frequency.setValueAtTime(freq, t0);
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(gain, t0 + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      osc.connect(g);
      g.connect(audioCtx.destination);
      osc.start(t0);
      osc.stop(t0 + dur + 0.02);
    }catch(e){ /* ignore */ }
  }

  function chord(){
    beep('triangle', 392, .08, .02);
    setTimeout(()=>beep('triangle', 523.25, .08, .02), 30);
    setTimeout(()=>beep('triangle', 659.25, .10, .018), 60);
  }

  /*** Game Data ***/
  const REALMS = [
    { name:'炼气', need: 1200 },
    { name:'筑基', need: 3600 },
    { name:'金丹', need: 9800 },
    { name:'元婴', need: 26000 },
    { name:'化神', need: 70000 },
    { name:'合体', need: 180000 },
    { name:'渡劫', need: 450000 },
    { name:'大乘', need: 1100000 },
    { name:'飞升', need: 2600000 },
  ];

  const LINGGEN = [
    { name:'五灵杂根', mult: 0.92 },
    { name:'三灵清根', mult: 1.00 },
    { name:'双灵妙根', mult: 1.10 },
    { name:'天灵根', mult: 1.22 },
    { name:'混元道体', mult: 1.35 },
  ];

  const SKILLS = [
    { id:'breath', name:'太初吐纳', desc:'吐纳速率 +20%。', cost: 10, req: ()=>true, apply:(s)=>s.mods.auraRate *= 1.20 },
    { id:'array', name:'星纹聚灵阵', desc:'灵阵升阶费用 -12%，吐纳速率 +8%。', cost: 18, req:(s)=>s.skills.includes('breath'), apply:(s)=>{ s.mods.arrayCost *= 0.88; s.mods.auraRate *= 1.08; } },
    { id:'insight', name:'观想灵台', desc:'悟性 +8，突破基础成功率 +3%。', cost: 22, req:(s)=>s.skills.includes('breath'), apply:(s)=>{ s.stats.wuxing += 8; s.mods.breakBase += 0.03; } },
    { id:'luck', name:'鸿运微引', desc:'气运 +10，秘境奇遇概率上升。', cost: 24, req:(s)=>s.skills.includes('insight'), apply:(s)=>{ s.stats.qiyun += 10; s.mods.eventLuck += 0.12; } },
    { id:'mind', name:'神识如潮', desc:'神识 +12，战斗闪避与暴击略升。', cost: 28, req:(s)=>s.skills.includes('array'), apply:(s)=>{ s.stats.shenshi += 12; s.mods.combatCrit += 0.04; s.mods.combatDodge += 0.05; } },
    { id:'alchemy', name:'丹道一线', desc:'炼丹品质上限提升，炼丹产量 +1（小概率）。', cost: 30, req:(s)=>s.skills.includes('insight'), apply:(s)=>{ s.mods.alchemyQuality += 0.12; s.mods.alchemyBonus += 0.18; } },
    { id:'forge', name:'器火真诀', desc:'炼器耐久提升，秘境战斗伤害略升。', cost: 30, req:(s)=>s.skills.includes('mind'), apply:(s)=>{ s.mods.weaponDur += 0.20; s.mods.combatDmg += 0.06; } },
    { id:'fate', name:'命盘回响', desc:'突破失败不再掉境界（但仍会受创），并提升一次性悟得残页。', cost: 44, req:(s)=>s.skills.includes('luck') && s.skills.includes('forge'), apply:(s)=>{ s.mods.noRealmDrop = true; s.mods.scrollOnFail += 1; } },
  ];

  const ACHS = [
    { id:'firstRun', name:'初入星渊', desc:'完成一次秘境行程（不论成败）。', test:(s)=>s.achsProgress.runs >= 1 },
    { id:'firstBreak', name:'破境一线', desc:'成功突破一次。', test:(s)=>s.achsProgress.breaks >= 1 },
    { id:'alchemyMade', name:'丹香初起', desc:'炼制丹药累计 ≥ 10。', test:(s)=>s.achsProgress.pills >= 10 },
    { id:'forgeMade', name:'锋芒未试', desc:'炼制法器累计 ≥ 3。', test:(s)=>s.achsProgress.weapons >= 3 },
    { id:'bossDown', name:'斩魇', desc:'击败一次秘境魇主。', test:(s)=>s.achsProgress.bosses >= 1 },
  ];

  /*** State ***/
  const STORAGE_KEY = 'xuanqiong_wendao_save_v1';

  function defaultState(){
    const seed = Math.floor(Math.random()*1e9) ^ (Date.now() & 0xffffffff);
    const rng = mulberry32(seed);
    const lg = LINGGEN[Math.floor(rng()*LINGGEN.length)];

    const baseW = Math.floor(28 + rng()*30); // 28-58
    const baseQ = Math.floor(22 + rng()*35); // 22-57
    const baseS = Math.floor(18 + rng()*38); // 18-56

    return {
      version: 1,
      createdAt: Date.now(),
      seed,
      soundOn: true,

      realmIdx: 0,
      realmProg: 0,

      // resources
      res: { aura: 180, stone: 80, pill: 1, scroll: 0, mat: 6 },

      arrayLv: 0,
      daoPoints: 0, // 用于玄图

      // base stats
      stats: {
        linggenName: lg.name,
        linggenMult: lg.mult,
        wuxing: baseW,
        qiyun: baseQ,
        shenshi: baseS,
      },

      // modifiers from skills, equipment
      mods: {
        auraRate: 1,
        arrayCost: 1,
        breakBase: 0,
        eventLuck: 0,
        combatCrit: 0,
        combatDodge: 0,
        combatDmg: 0,
        alchemyQuality: 0,
        alchemyBonus: 0,
        weaponDur: 0,
        noRealmDrop: false,
        scrollOnFail: 0,
      },

      skills: [],

      // combat kit
      weapon: { name:'空明剑胚', lv: 0, dur: 1.0, affix:'', },

      // run
      run: {
        active:false,
        title:'未进入秘境',
        floor:0,
        maxFloor:0,
        danger:0,
        hp: 100,
        hpMax: 100,
        mp: 60,
        mpMax: 60,
        stance: 'balanced',
        mapSeed: 0,
        pendingEvent: null,
        lastNode: null,
      },

      achs: {},
      achsProgress: { runs:0, breaks:0, pills:0, weapons:0, bosses:0 },

      // idle
      lastTick: Date.now(),
      totalPlayMs: 0,
    };
  }

  function loadState(){
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultState();
    try{
      const s = JSON.parse(raw);
      // basic migration guard
      if (!s.version) return defaultState();
      return s;
    }catch{ return defaultState(); }
  }

  function saveState(){
    state.lastTick = Date.now();
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }

  let state = loadState();

  /*** Derived computations ***/
  function realmNeed(){ return REALMS[state.realmIdx]?.need ?? REALMS[REALMS.length-1].need; }

  function auraRate(){
    // base from linggen, array, skills, realm
    const realmBoost = 1 + state.realmIdx * 0.08;
    const arrayBoost = 1 + state.arrayLv * 0.10;
    const wuxingBoost = 1 + (state.stats.wuxing - 20) * 0.007;
    return 1.2 * state.stats.linggenMult * realmBoost * arrayBoost * wuxingBoost * state.mods.auraRate;
  }

  function daoPointRate(){
    // earn points slowly by play and by breakthroughs
    return 0.0022 * (1 + state.stats.shenshi/80) * (1 + state.realmIdx*0.06);
  }

  function breakChance(){
    // base chance scales down by realm, scales up with stats & array
    const base = 0.58 - state.realmIdx * 0.055;
    const w = (state.stats.wuxing/100) * 0.18;
    const q = (state.stats.qiyun/100) * 0.16;
    const a = state.arrayLv * 0.035;
    const s = (state.stats.shenshi/100) * 0.08;
    const pill = state.res.pill > 0 ? 0.05 : 0;
    const scroll = state.res.scroll >= 2 ? 0.03 : 0;
    const bonus = state.mods.breakBase;
    return clamp(base + w + q + a + s + pill + scroll + bonus, 0.05, 0.92);
  }

  function breakCostAura(){
    return Math.floor(realmNeed() * (0.60 + state.realmIdx*0.06));
  }

  function breakCostMat(){
    return Math.max(3, Math.floor(4 + state.realmIdx*1.3));
  }

  function arrayCost(){
    const base = 120 + Math.pow(1.35, state.arrayLv) * 140;
    return Math.floor(base * state.mods.arrayCost);
  }

  /*** Rendering ***/
  function setText(id, text){ const el = $(id); if (el) el.textContent = text; }

  function render(){
    setText('#realm', `${REALMS[state.realmIdx].name} · 第${state.realmIdx+1}重`);
    const pct = clamp(state.realmProg / realmNeed(), 0, 1);
    const circumference = 276;
    $('#realmProgress').style.strokeDashoffset = String(Math.floor(circumference * (1 - pct)));
    setText('#realmPct', `${Math.floor(pct*100)}%`);

    setText('#statLinggen', state.stats.linggenName);
    setText('#statWuxing', state.stats.wuxing);
    setText('#statQiyun', state.stats.qiyun);
    setText('#statShenshi', state.stats.shenshi);

    setText('#resAura', fmt(state.res.aura));
    setText('#resStone', fmt(state.res.stone));
    setText('#resPill', fmt(state.res.pill));
    setText('#resScroll', fmt(state.res.scroll));
    setText('#resMat', fmt(state.res.mat));

    setText('#auraRate', auraRate().toFixed(2));
    setText('#arrayLv', state.arrayLv);

    // run
    setText('#runTitle', state.run.active ? state.run.title : '未进入秘境');
    setText('#floor', state.run.floor);
    setText('#maxFloor', state.run.maxFloor);
    setText('#hp', Math.floor(state.run.hp));
    setText('#hpMax', state.run.hpMax);
    setText('#mp', Math.floor(state.run.mp));
    setText('#mpMax', state.run.mpMax);

    $('#hpFill').style.width = `${clamp(state.run.hp/state.run.hpMax,0,1)*100}%`;
    $('#mpFill').style.width = `${clamp(state.run.mp/state.run.mpMax,0,1)*100}%`;

    const tag = $('#dangerTag');
    if (!state.run.active){
      tag.textContent = '宁静';
      tag.className = 'tag';
    }else{
      const d = state.run.danger;
      if (d < 0.35){ tag.textContent='微澜'; tag.className='tag ok'; }
      else if (d < 0.65){ tag.textContent='暗涌'; tag.className='tag'; }
      else { tag.textContent='魇潮'; tag.className='tag danger'; }
    }

    // buttons enable
    $('#btnStep').disabled = !state.run.active;
    $('#btnRest').disabled = !state.run.active;
    $('#btnExit').disabled = !state.run.active;
    $('#btnEnter').disabled = state.run.active;

    // sound
    soundOn = !!state.soundOn;
    $('#btnSound').textContent = soundOn ? '音效：开' : '音效：关';

    renderSkills();
    renderCraft();
    renderAchs();
  }

  function renderSkills(){
    const box = $('#skillTree');
    box.innerHTML = '';
    for (const sk of SKILLS){
      const owned = state.skills.includes(sk.id);
      const can = sk.req(state) && !owned;
      const el = document.createElement('div');
      el.className = 'skill' + (can||owned ? '' : ' locked');
      el.innerHTML = `
        <div class="name">${sk.name}</div>
        <div class="desc">${sk.desc}</div>
        <div class="meta"><span class="cost">道点 ${sk.cost}</span><span>${owned?'已参悟':(can?'可参悟':'未解锁')}</span></div>
      `;
      const btn = document.createElement('button');
      btn.className = 'btn';
      btn.textContent = owned ? '已掌握' : '参悟';
      btn.disabled = !can || state.daoPoints < sk.cost;
      btn.addEventListener('click', ()=> learnSkill(sk.id));
      el.appendChild(btn);
      box.appendChild(el);
    }
  }

  function renderCraft(){
    const alc = $('#alchemy');
    const forge = $('#forge');

    alc.innerHTML = '';
    forge.innerHTML = '';

    const recipes = [
      {
        id:'heal',
        title:'回元丹',
        hint:'秘境中调息效果增强。',
        cost:{ mat:3, stone:30 },
        act:()=>craftAlchemy('heal')
      },
      {
        id:'insight',
        title:'悟真丹',
        hint:'突破时成功率微增（消耗后生效一次）。',
        cost:{ mat:4, stone:45 },
        act:()=>craftAlchemy('insight')
      },
      {
        id:'ward',
        title:'镇魇丹',
        hint:'降低本次秘境危险度。',
        cost:{ mat:5, stone:60 },
        act:()=>craftAlchemy('ward')
      },
    ];

    const weaponRecipes = [
      {
        id:'edge',
        title:'玄锋·灵剑',
        hint:'提升秘境伤害，耐久随战斗消耗。',
        cost:{ mat:6, stone:80, scroll:1 },
        act:()=>craftForge('edge')
      },
      {
        id:'mirror',
        title:'照心·灵镜',
        hint:'提升闪避与暴击，偏玄诡。',
        cost:{ mat:7, stone:95, scroll:1 },
        act:()=>craftForge('mirror')
      },
      {
        id:'talisman',
        title:'护界·符印',
        hint:'略增体魄上限，调息效果增强。',
        cost:{ mat:8, stone:110, scroll:2 },
        act:()=>craftForge('talisman')
      },
    ];

    for (const r of recipes){
      alc.appendChild(recipeNode(r));
    }
    for (const r of weaponRecipes){
      forge.appendChild(recipeNode(r));
    }
  }

  function recipeNode(r){
    const el = document.createElement('div');
    el.className = 'recipe';
    const costText = Object.entries(r.cost).map(([k,v])=>`${k}:${v}`).join(' · ');
    el.innerHTML = `
      <div class="row">
        <div class="title">${r.title}</div>
        <div class="tag">${costText}</div>
      </div>
      <div class="hint">${r.hint}</div>
      <div class="meta">
        <span>灵材 <b>${fmt(state.res.mat)}</b></span>
        <span>灵石 <b>${fmt(state.res.stone)}</b></span>
        <span>残页 <b>${fmt(state.res.scroll)}</b></span>
      </div>
    `;
    const btn = document.createElement('button');
    btn.className = 'btn';
    btn.textContent = '炼制';
    btn.disabled = !hasCost(r.cost);
    btn.addEventListener('click', r.act);
    el.appendChild(btn);
    return el;
  }

  function renderAchs(){
    const box = $('#achievements');
    box.innerHTML = '';
    for (const a of ACHS){
      const done = !!state.achs[a.id] || a.test(state);
      if (done) state.achs[a.id] = true;
      const el = document.createElement('div');
      el.className = 'ach' + (done ? ' done' : '');
      el.innerHTML = `
        <div class="name">${done?'✦ ':''}${a.name}</div>
        <div class="desc">${a.desc}</div>
      `;
      box.appendChild(el);
    }
  }

  /*** Modal ***/
  function showModal(title, html){
    $('#modalTitle').textContent = title;
    $('#modalBody').innerHTML = html;
    $('#modal').classList.remove('hidden');
    beep('sine', 660, .06, .015);
  }
  function hideModal(){ $('#modal').classList.add('hidden'); }

  $('#modalClose').addEventListener('click', hideModal);
  $('#modalOk').addEventListener('click', hideModal);
  $('#modal').addEventListener('click', (e)=>{ if(e.target.id==='modal') hideModal(); });

  /*** Logging ***/
  function log(msg, tone='normal'){
    const box = $('#log');
    const line = document.createElement('div');
    const t = new Date();
    const stamp = t.toLocaleTimeString('zh-CN', {hour12:false});
    const toneColor = tone==='good' ? 'rgba(88,240,167,.9)' : tone==='bad' ? 'rgba(255,140,165,.95)' : 'rgba(255,255,255,.78)';
    line.innerHTML = `<span style="color:rgba(255,255,255,.45); font-family:var(--mono)">[${stamp}]</span> <span style="color:${toneColor}">${msg}</span>`;
    box.prepend(line);
    while (box.children.length > 120) box.removeChild(box.lastChild);
  }

  /*** Idle tick ***/
  let last = now();

  function tick(){
    const t = now();
    const dt = Math.min(0.08, (t-last)/1000);
    last = t;

    // passive aura
    const gain = auraRate() * dt;
    state.res.aura += gain;

    // dao points slowly
    state.daoPoints += daoPointRate() * dt;

    // offline compensation each second (coarse)
    const realNow = Date.now();
    const idleDt = clamp((realNow - state.lastTick)/1000, 0, 60*60*6);
    if (idleDt > 1.2){
      // apply once and reset
      state.res.aura += auraRate() * idleDt * 0.85; // slight decay to avoid abuse
      state.daoPoints += daoPointRate() * idleDt * 0.85;
      state.lastTick = realNow;
      log(`你离线归来，灵气与道点已回流（约 ${Math.floor(idleDt)} 秒）。`, 'good');
      chord();
    }

    // accumulate realm progress from aura (soft)
    const progRate = 0.11 + state.realmIdx * 0.02;
    state.realmProg += gain * progRate;
    if (state.realmProg > realmNeed()) state.realmProg = realmNeed();

    // run natural mp regen
    if (state.run.active){
      const regen = (0.9 + state.arrayLv*0.05) * dt;
      state.run.mp = clamp(state.run.mp + regen, 0, state.run.mpMax);
    }

    // weapon dur slow decay if in run
    if (state.run.active && state.weapon && state.weapon.lv > 0){
      state.weapon.dur = clamp(state.weapon.dur - dt * 0.0025, 0, 1);
    }

    state.totalPlayMs += dt*1000;

    if (Math.floor(t/1000) !== Math.floor((t-dt*1000)/1000)){
      saveState();
      checkAchs();
    }

    render();
    requestAnimationFrame(tick);
  }

  /*** Skills ***/
  function recomputeMods(){
    // reset then apply
    const baseMods = defaultState().mods;
    state.mods = JSON.parse(JSON.stringify(baseMods));
    // IMPORTANT: do not reset stats base beyond current, so apply skill modifications from a snapshot
    // We'll reconstruct from seed base each time for determinism.
    const base = defaultState();
    base.seed = state.seed;
    // rebuild base stats from seed
    const rng = mulberry32(state.seed);
    const lg = LINGGEN[Math.floor(rng()*LINGGEN.length)];
    const baseW = Math.floor(28 + rng()*30);
    const baseQ = Math.floor(22 + rng()*35);
    const baseS = Math.floor(18 + rng()*38);
    state.stats.linggenName = lg.name;
    state.stats.linggenMult = lg.mult;
    state.stats.wuxing = baseW;
    state.stats.qiyun = baseQ;
    state.stats.shenshi = baseS;

    for (const id of state.skills){
      const sk = SKILLS.find(x=>x.id===id);
      if (sk) sk.apply(state);
    }
  }

  function learnSkill(id){
    const sk = SKILLS.find(x=>x.id===id);
    if (!sk) return;
    if (state.skills.includes(id)) return;
    if (!sk.req(state)) return;
    if (state.daoPoints < sk.cost) return;

    state.daoPoints -= sk.cost;
    state.skills.push(id);
    recomputeMods();
    log(`你参悟「${sk.name}」，道意流转。`, 'good');
    chord();
    render();
  }

  /*** Crafting ***/
  function hasCost(cost){
    for (const [k,v] of Object.entries(cost)){
      if ((state.res[k] ?? 0) < v) return false;
    }
    return true;
  }
  function payCost(cost){
    for (const [k,v] of Object.entries(cost)) state.res[k] -= v;
  }

  function qualityRoll(){
    // 0..1 quality; luck and alchemy mod influence
    const rng = mulberry32(state.seed ^ Math.floor(Date.now()/5000));
    const q = rng();
    const bonus = clamp(state.stats.qiyun/100*0.12 + state.mods.alchemyQuality, 0, 0.35);
    return clamp(q + bonus, 0, 1);
  }

  function craftAlchemy(kind){
    const recipe = {
      heal:{ mat:3, stone:30 },
      insight:{ mat:4, stone:45 },
      ward:{ mat:5, stone:60 },
    }[kind];
    if (!hasCost(recipe)) return;
    payCost(recipe);

    const q = qualityRoll();
    let extra = 0;
    const rng = mulberry32(state.seed ^ (Date.now() & 0xffffffff));
    if (rng() < (0.12 + state.mods.alchemyBonus)) extra = 1;

    state.res.pill += 1 + extra;
    state.achsProgress.pills += 1 + extra;

    // side effects
    if (kind==='ward'){
      state.run.danger = clamp(state.run.danger - (0.08 + q*0.10), 0, 1);
    }

    const grade = q>0.92?'绝品':q>0.78?'上品':q>0.55?'良品':q>0.30?'凡品':'残丹';
    log(`丹炉微震，你炼得「${grade}${kind==='heal'?'回元丹':kind==='insight'?'悟真丹':'镇魇丹'}」×${1+extra}。`, 'good');
    beep('triangle', 740, .09, .02);
    render();
  }

  function craftForge(kind){
    const recipe = {
      edge:{ mat:6, stone:80, scroll:1 },
      mirror:{ mat:7, stone:95, scroll:1 },
      talisman:{ mat:8, stone:110, scroll:2 },
    }[kind];
    if (!hasCost(recipe)) return;
    payCost(recipe);

    const q = qualityRoll();
    const lv = q>0.92?3:q>0.74?2:q>0.45?1:0;
    const names = {
      edge:['空明剑胚','玄锋·灵剑','玄锋·灵剑（铭纹）','玄锋·灵剑（天工）'],
      mirror:['照心坯镜','照心·灵镜','照心·灵镜（澄明）','照心·灵镜（太虚）'],
      talisman:['护界符坯','护界·符印','护界·符印（镇守）','护界·符印（玄界）'],
    };
    const affixes = [
      { name:'寒魄', eff:'闪避+2%/伤害+2%（秘境）' },
      { name:'赤曜', eff:'伤害+5%（秘境）' },
      { name:'青岚', eff:'调息额外回复' },
      { name:'玄阙', eff:'暴击+3%（秘境）' },
    ];
    const rng = mulberry32(state.seed ^ (Date.now() & 0xffffffff) ^ 0xabc);
    const aff = affixes[Math.floor(rng()*affixes.length)];

    state.weapon = {
      name: names[kind][lv],
      lv,
      dur: 1.0,
      affix: `「${aff.name}」${aff.eff}`,
      kind,
    };

    state.achsProgress.weapons += 1;

    log(`器火翻涌，你炼成「${state.weapon.name}」${lv?`（阶${lv}）`:''}，${state.weapon.affix}。`, 'good');
    chord();
    render();
  }

  /*** Run / Roguelite events ***/
  const NODES = ['战斗','奇遇','商队','机缘','休整'];

  function startRun(){
    if (state.run.active) return;
    state.run.active = true;
    state.run.mapSeed = (state.seed ^ (Date.now() & 0xffffffff)) >>> 0;
    const rng = mulberry32(state.run.mapSeed);

    const len = 7 + Math.floor(rng()*5) + Math.min(6, state.realmIdx);
    state.run.maxFloor = len;
    state.run.floor = 0;
    state.run.danger = clamp(0.18 + state.realmIdx*0.05 + rng()*0.10, 0, 1);
    state.run.hpMax = Math.floor(90 + state.realmIdx*12 + state.arrayLv*6 + state.stats.shenshi*0.5);
    state.run.mpMax = Math.floor(55 + state.realmIdx*8 + state.stats.wuxing*0.35);
    state.run.hp = state.run.hpMax;
    state.run.mp = state.run.mpMax;
    state.run.title = `星渊行 · ${len}层`;
    state.run.pendingEvent = null;
    state.run.lastNode = null;

    setScene('星渊启程', '星雾如帷，古道横陈。你踏入第一道裂隙，远处有低沉的魇息回响。', [
      { t:'踏入', f: stepRun },
      { t:'谨慎观望', f: ()=>{ state.run.danger = clamp(state.run.danger - 0.03, 0, 1); log('你收敛气息，危险度略降。', 'good'); stepRun(); } },
    ]);

    state.achsProgress.runs += 1;
    log('你进入秘境：星渊行。', 'good');
    chord();
    render();
  }

  function endRun(reason='退隐'){
    if (!state.run.active) return;
    state.run.active = false;
    setScene('归于洞府', `你从秘境中抽身而退。此行因「${reason}」而止。`, [
      { t:'整理收获', f: ()=>{ hideChoices(); render(); } },
    ]);
    log(`秘境行结束：${reason}。`, 'normal');
    beep('sine', 300, .08, .02);
    render();
  }

  function stepRun(){
    if (!state.run.active) return;

    // if last event has unresolved choice, ignore
    if (state.run.pendingEvent) return;

    state.run.floor += 1;
    if (state.run.floor > state.run.maxFloor){
      // success: reward
      const bonus = Math.floor(120 + state.run.maxFloor*25 + state.stats.qiyun*2);
      state.res.stone += bonus;
      state.res.mat += 3 + Math.floor(state.run.danger*4);
      state.res.scroll += (Math.random() < 0.25 + state.mods.eventLuck ? 1 : 0);
      state.daoPoints += 9 + state.run.maxFloor*0.6;
      setScene('星渊尽头', `你穿过最后一道裂隙，星渊的回声在你身后合拢。你获得灵石+${bonus}、灵材与道意。`, [
        { t:'归返', f: ()=>endRun('功成返身') },
      ]);
      log(`星渊行完满：灵石 +${bonus}。`, 'good');
      chord();
      return;
    }

    // danger increases slightly
    state.run.danger = clamp(state.run.danger + 0.02 + Math.random()*0.015, 0, 1);

    // choose node
    const rng = mulberry32(state.run.mapSeed ^ state.run.floor);
    let pEvent = 0.20 + state.mods.eventLuck + state.stats.qiyun/220;
    let pMerchant = 0.12 + state.stats.qiyun/450;
    let pChance = 0.12 + state.stats.wuxing/500;
    let pRest = 0.11;

    // normalize with danger
    if (state.run.danger > 0.66){ pEvent *= 0.85; pRest *= 1.15; }

    const roll = rng();
    let node = '战斗';
    const c1 = pEvent;
    const c2 = c1 + pMerchant;
    const c3 = c2 + pChance;
    const c4 = c3 + pRest;
    if (roll < c1) node='奇遇';
    else if (roll < c2) node='商队';
    else if (roll < c3) node='机缘';
    else if (roll < c4) node='休整';

    // boss at last floor
    if (state.run.floor === state.run.maxFloor){
      node = '魇主';
    }

    state.run.lastNode = node;

    if (node === '战斗') return eventCombat();
    if (node === '奇遇') return eventWonder();
    if (node === '商队') return eventMerchant();
    if (node === '机缘') return eventChance();
    if (node === '休整') return eventRest();
    if (node === '魇主') return eventBoss();
  }

  function setScene(title, desc, choices){
    $('.scene-title').textContent = title;
    $('.scene-desc').textContent = desc;
    const box = $('#choices');
    box.innerHTML = '';
    for (const c of choices || []){
      const b = document.createElement('button');
      b.className = 'choice';
      b.textContent = c.t;
      b.addEventListener('click', c.f);
      box.appendChild(b);
    }
  }

  function hideChoices(){ $('#choices').innerHTML = ''; }

  // Combat model
  function stanceMods(){
    const s = state.run.stance;
    if (s==='aggressive') return { dmg:1.16, dodge:0.90, crit:1.20, mp:1.10 };
    if (s==='guard') return { dmg:0.92, dodge:1.12, crit:0.92, mp:0.95 };
    if (s==='mystic') return { dmg:1.04, dodge:1.05, crit:1.10, mp:1.18 };
    return { dmg:1.00, dodge:1.00, crit:1.00, mp:1.00 };
  }

  function playerPower(){
    const weaponLv = state.weapon?.lv ?? 0;
    const dur = state.weapon?.dur ?? 1;
    const weaponBoost = 1 + weaponLv*0.10 + (dur>0.2?0.03:0);

    const base = 12 + state.realmIdx*3.6 + state.arrayLv*1.7;
    const w = 1 + state.stats.wuxing/110;
    const s = 1 + state.stats.shenshi/140;
    return base * w * s * weaponBoost * (1 + state.mods.combatDmg);
  }

  function enemyPower(scale=1){
    const base = 10 + state.run.floor*2.2 + state.realmIdx*3.2;
    return base * (1 + state.run.danger*0.55) * scale;
  }

  function combatResolve(name, scale=1, boss=false){
    const rng = mulberry32(state.run.mapSeed ^ hashCode(name) ^ (Date.now() & 0xffffffff));
    const stance = stanceMods();

    let hpLoss = 0;
    let mpLoss = 0;
    let rewardStone = 0;
    let rewardMat = 0;
    let rewardScroll = 0;

    const p = playerPower() * stance.dmg;
    const e = enemyPower(scale);

    // crit & dodge
    const crit = clamp(0.07 + state.mods.combatCrit + state.stats.shenshi/600, 0.05, 0.35) * stance.crit;
    const dodge = clamp(0.06 + state.mods.combatDodge + state.stats.shenshi/520, 0.05, 0.30) * stance.dodge;

    const critHit = rng() < crit;
    const dodged = rng() < dodge;

    // battle turns
    const ratio = (p*(critHit?1.22:1)) / e;

    // mp usage
    const mpUse = (8 + state.run.danger*10) * stance.mp;
    mpLoss = clamp(mpUse, 0, state.run.mp);

    // hp loss based on ratio
    let baseLoss = boss ? 18 : 12;
    baseLoss += state.run.danger * (boss?22:14);
    if (ratio >= 1.25) baseLoss *= 0.55;
    else if (ratio >= 1.0) baseLoss *= 0.75;
    else if (ratio >= 0.82) baseLoss *= 1.05;
    else baseLoss *= 1.38;

    if (dodged) baseLoss *= 0.68;

    // weapon durability loss
    if (state.weapon && state.weapon.lv > 0){
      state.weapon.dur = clamp(state.weapon.dur - (boss?0.08:0.04) - state.run.danger*0.02, 0, 1);
    }

    hpLoss = clamp(baseLoss * (0.85 + rng()*0.40), 2, 80);

    // rewards
    rewardStone = Math.floor(35 + e*4.2 + state.stats.qiyun*0.9);
    rewardMat = Math.floor(1 + rng()*2 + state.run.danger*3);
    rewardScroll = (rng() < (boss?0.42:0.10) + state.mods.eventLuck*0.35) ? 1 : 0;

    // apply
    state.run.hp = clamp(state.run.hp - hpLoss, 0, state.run.hpMax);
    state.run.mp = clamp(state.run.mp - mpLoss, 0, state.run.mpMax);

    state.res.stone += rewardStone;
    state.res.mat += rewardMat;
    state.res.scroll += rewardScroll;

    if (critHit) beep('sine', 980, .06, .02);
    else beep('triangle', 620, .06, .015);

    const outcome = ratio < 0.55 ? '险败' : ratio < 0.9 ? '苦战' : ratio < 1.25 ? '胜' : '大胜';
    const extras = [];
    if (critHit) extras.push('暴击');
    if (dodged) extras.push('身法');
    if (rewardScroll) extras.push('得残页');

    log(`你与「${name}」交锋：${outcome}，体魄 -${Math.floor(hpLoss)}，真元 -${Math.floor(mpLoss)}，灵石 +${rewardStone}，灵材 +${rewardMat}${rewardScroll? '，残页 +1':''}${extras.length?`（${extras.join('·')}）`:''}。`, outcome==='大胜' || outcome==='胜' ? 'good' : (outcome==='苦战'?'normal':'bad'));

    if (state.run.hp <= 0){
      setScene('魇息侵骨', '你体魄枯竭，星渊魇息攀附心神。此行已无力再进。', [
        { t:'退隐', f: ()=>endRun('体魄枯竭') },
      ]);
      beep('sine', 210, .10, .03);
      return;
    }

    setScene('余波未息', boss ? '魇主陨落，星渊似有裂缝在缓缓愈合。' : '战后尘埃落定，裂隙仍在前方等待。', [
      { t:'继续前行', f: ()=>{ state.run.pendingEvent=null; stepRun(); } },
      { t:'调息片刻', f: ()=>restRun(true) },
    ]);
  }

  function eventCombat(){
    const mobs = ['雾魇妖','裂影蛛','星渊狼','空鸣鸦','黑砂傀'];
    const rng = mulberry32(state.run.mapSeed ^ (state.run.floor*1337));
    const name = mobs[Math.floor(rng()*mobs.length)];

    state.run.pendingEvent = 'combat';
    setScene('战斗', `前方黑雾凝成「${name}」，杀意逼人。你选择如何应对？`, [
      { t:'迎战', f: ()=>combatResolve(name, 1.0, false) },
      { t:'以真元破阵（耗真元，减伤）', f: ()=>{ state.run.mp = clamp(state.run.mp - 10, 0, state.run.mpMax); combatResolve(name, 0.92, false); } },
      { t:'谨慎迂回（略降危险）', f: ()=>{ state.run.danger = clamp(state.run.danger - 0.03, 0, 1); combatResolve(name, 1.05, false); } },
    ]);
  }

  function eventBoss(){
    const rng = mulberry32(state.run.mapSeed ^ 0xdeadbeef);
    const bosses = ['魇主·无相','魇主·噬梦','魇主·断星'];
    const name = bosses[Math.floor(rng()*bosses.length)];

    state.run.pendingEvent = 'boss';
    setScene('魇主', `最后一层，星渊骤冷。「${name}」自裂隙深处现形。此战若胜，造化尽归你。`, [
      { t:'决战', f: ()=>{ combatResolve(name, 1.55, true); state.achsProgress.bosses += 1; } },
      { t:'服丹镇心（消耗丹药，减伤）', f: ()=>{
        if (state.res.pill<=0){ log('你丹药不足。', 'bad'); return; }
        state.res.pill -= 1;
        state.run.danger = clamp(state.run.danger - 0.06, 0, 1);
        state.run.mp = clamp(state.run.mp + 14, 0, state.run.mpMax);
        combatResolve(name, 1.48, true);
        state.achsProgress.bosses += 1;
      } },
      { t:'退隐（放弃收官奖励）', f: ()=>endRun('畏魇退身') },
    ]);
  }

  function eventWonder(){
    state.run.pendingEvent = 'wonder';
    const rng = mulberry32(state.run.mapSeed ^ (state.run.floor*9999));
    const roll = rng();

    if (roll < 0.33){
      setScene('奇遇', '你在残碑旁发现一缕温润灵光，似可温养经脉。', [
        { t:'收纳灵光', f: ()=>{ const gain = 160 + Math.floor(rng()*120); state.res.aura += gain; state.run.danger = clamp(state.run.danger + 0.02,0,1); log(`你收纳灵光，灵气 +${gain}。`, 'good'); state.run.pendingEvent=null; stepRun(); } },
        { t:'以阵稳固（消耗灵石，换安全）', f: ()=>{ if (state.res.stone<80){ log('灵石不足。','bad'); return; } state.res.stone-=80; state.run.danger = clamp(state.run.danger - 0.07,0,1); log('你以灵石稳固阵势，危险度下降。','good'); state.run.pendingEvent=null; stepRun(); } },
      ]);
    } else if (roll < 0.66){
      setScene('奇遇', '一卷古简飘落，字迹半灭半明。', [
        { t:'参悟片刻', f: ()=>{ const add = 1 + (rng()<0.25?1:0); state.res.scroll += add; state.daoPoints += 4.5; log(`你悟得残页 ×${add}，并获少许道点。`, 'good'); beep('sine', 860, .07, .02); state.run.pendingEvent=null; stepRun(); } },
        { t:'谨慎封存（少量收益，降危险）', f: ()=>{ state.res.scroll += 1; state.run.danger = clamp(state.run.danger - 0.04,0,1); log('你封存古简，残页 +1，危险度略降。','good'); state.run.pendingEvent=null; stepRun(); } },
      ]);
    } else {
      setScene('奇遇', '你听见低语回荡，似在诱你踏入更深的裂隙。', [
        { t:'顺势深入（高风险，高回报）', f: ()=>{ state.run.danger = clamp(state.run.danger + 0.10,0,1); const stone = 180 + Math.floor(rng()*180); state.res.stone += stone; state.res.mat += 2 + Math.floor(rng()*3); log(`你夺得机缘：灵石 +${stone}，但魇息更浓。`, 'good'); state.run.pendingEvent=null; stepRun(); } },
        { t:'封耳凝神（消耗真元，降风险）', f: ()=>{ state.run.mp = clamp(state.run.mp - 12,0,state.run.mpMax); state.run.danger = clamp(state.run.danger - 0.08,0,1); log('你封耳凝神，危险度显著下降。', 'good'); state.run.pendingEvent=null; stepRun(); } },
      ]);
    }
  }

  function eventMerchant(){
    state.run.pendingEvent = 'merchant';
    const rng = mulberry32(state.run.mapSeed ^ (state.run.floor*4242));
    const pricePill = 90 + Math.floor(rng()*35);
    const priceScroll = 140 + Math.floor(rng()*70);
    setScene('商队', '星雾中有一支游商，灯火微微，似不惧魇息。', [
      { t:`购丹（${pricePill}灵石）`, f: ()=>{ if(state.res.stone<pricePill){ log('灵石不足。','bad'); return;} state.res.stone-=pricePill; state.res.pill+=1; log('你购得丹药 +1。','good'); beep('triangle', 720, .06, .02); state.run.pendingEvent=null; stepRun(); } },
      { t:`购残页（${priceScroll}灵石）`, f: ()=>{ if(state.res.stone<priceScroll){ log('灵石不足。','bad'); return;} state.res.stone-=priceScroll; state.res.scroll+=1; log('你购得残页 +1。','good'); beep('triangle', 760, .06, .02); state.run.pendingEvent=null; stepRun(); } },
      { t:'以物易物（灵材换灵石）', f: ()=>{ if(state.res.mat<3){ log('灵材不足。','bad'); return;} const stone = 120 + Math.floor(rng()*80); state.res.mat-=3; state.res.stone+=stone; log(`你以灵材换得灵石 +${stone}。`, 'good'); state.run.pendingEvent=null; stepRun(); } },
      { t:'离开', f: ()=>{ log('你不与游商多谈。', 'normal'); state.run.pendingEvent=null; stepRun(); } },
    ]);
  }

  function eventChance(){
    state.run.pendingEvent = 'chance';
    const rng = mulberry32(state.run.mapSeed ^ (state.run.floor*8080));
    const pick = rng();
    if (pick < 0.5){
      setScene('机缘', '你发现一处「静念台」，适合凝神观想。', [
        { t:'观想（耗真元，得道点）', f: ()=>{ const cost=14; if(state.run.mp<cost){ log('真元不足。','bad'); return;} state.run.mp-=cost; const pts = 7 + rng()*5; state.daoPoints += pts; log(`你观想灵台，道点 +${pts.toFixed(1)}。`, 'good'); state.run.pendingEvent=null; stepRun(); } },
        { t:'刻阵（耗灵石，提体魄上限）', f: ()=>{ const cost=120; if(state.res.stone<cost){ log('灵石不足。','bad'); return;} state.res.stone-=cost; state.run.hpMax += 10 + Math.floor(rng()*8); state.run.hp += 10; log('你刻阵稳固体魄，体魄上限提高。','good'); state.run.pendingEvent=null; stepRun(); } },
      ]);
    } else {
      setScene('机缘', '裂隙旁浮现一道「玄符」，似可暂避魇息。', [
        { t:'引符护体（降危险）', f: ()=>{ state.run.danger = clamp(state.run.danger - (0.06 + rng()*0.06),0,1); log('玄符融入经脉，危险度下降。','good'); state.run.pendingEvent=null; stepRun(); } },
        { t:'拆符取材（得灵材，增危险）', f: ()=>{ const m=3+Math.floor(rng()*3); state.res.mat+=m; state.run.danger = clamp(state.run.danger + 0.06,0,1); log(`你拆符取材，灵材 +${m}，但魇息加重。`, 'good'); state.run.pendingEvent=null; stepRun(); } },
      ]);
    }
  }

  function restRun(force=false){
    if (!state.run.active) return;
    // rest consumes time; use aura or pill to heal
    const rng = mulberry32(state.run.mapSeed ^ 0x1234 ^ state.run.floor);
    let heal = 14 + state.arrayLv*2 + state.stats.shenshi*0.06;
    let mp = 18 + state.stats.wuxing*0.10;

    if (state.res.pill>0 && (force || rng()<0.35)){
      state.res.pill -= 1;
      heal *= 1.55;
      mp *= 1.45;
      log('你服下一枚丹药，气机回环。', 'good');
      beep('sine', 740, .06, .02);
    }

    state.run.hp = clamp(state.run.hp + heal, 0, state.run.hpMax);
    state.run.mp = clamp(state.run.mp + mp, 0, state.run.mpMax);
    state.run.danger = clamp(state.run.danger - 0.03, 0, 1);

    setScene('调息', '你在裂隙间隙盘坐调息，呼吸与星雾同频。', [
      { t:'继续前行', f: ()=>{ state.run.pendingEvent=null; stepRun(); } },
    ]);
    log(`调息完成：体魄 +${Math.floor(heal)}，真元 +${Math.floor(mp)}，危险度略降。`, 'good');
  }

  function eventRest(){
    state.run.pendingEvent = 'rest';
    setScene('休整', '此处星雾稀薄，适合短暂休整。', [
      { t:'调息', f: ()=>restRun(false) },
      { t:'强行吐纳（得灵气，增危险）', f: ()=>{ const gain = 220 + Math.floor(Math.random()*140); state.res.aura += gain; state.run.danger = clamp(state.run.danger + 0.05,0,1); log(`你强行吞纳星雾，灵气 +${gain}。`, 'good'); state.run.pendingEvent=null; stepRun(); } },
    ]);
  }

  /*** Breakthrough ***/
  function breakthrough(){
    // Need aura and mats
    const needAura = breakCostAura();
    const needMat = breakCostMat();
    if (state.res.aura < needAura){
      log(`灵气不足：需 ${needAura}。`, 'bad');
      beep('sine', 260, .05, .02);
      return;
    }
    if (state.res.mat < needMat){
      log(`灵材不足：需 ${needMat}。`, 'bad');
      beep('sine', 260, .05, .02);
      return;
    }

    // optional consume scroll for bonus insight
    let usedPill = false;
    let usedScroll = false;
    let extra = 0;
    if (state.res.pill > 0 && Math.random() < 0.33){
      state.res.pill -= 1;
      usedPill = true;
      extra += 0.03;
    }
    if (state.res.scroll >= 2 && Math.random() < 0.28){
      state.res.scroll -= 2;
      usedScroll = true;
      extra += 0.02;
    }

    state.res.aura -= needAura;
    state.res.mat -= needMat;

    const chance = clamp(breakChance() + extra, 0.05, 0.95);
    const rng = mulberry32(state.seed ^ (Date.now() & 0xffffffff) ^ state.realmIdx);
    const ok = rng() < chance;

    if (ok){
      state.realmIdx = Math.min(state.realmIdx+1, REALMS.length-1);
      state.realmProg = 0;
      state.daoPoints += 16 + state.realmIdx*2;
      state.stats.wuxing += 1 + Math.floor(rng()*2);
      state.stats.shenshi += 1;
      state.achsProgress.breaks += 1;
      log(`闭关冲关：破境成功！迈入「${REALMS[state.realmIdx].name}」。`, 'good');
      chord();
      showModal('破境成功', `
        <p>你引灵入脉，周天大转，瓶颈应声而碎。</p>
        <p><b>收获：</b>境界提升，悟性与神识微增，道点回响。</p>
        <p class="muted">（成功率：${Math.floor(chance*100)}%${usedPill?'，已用丹':''}${usedScroll?'，已用残页':''}）</p>
      `);
    } else {
      // failure: take damage; maybe realm drop
      const backlash = 18 + Math.floor(rng()*16) + state.realmIdx*3;
      state.run.hp = clamp(state.run.hp - backlash, 0, state.run.hpMax);

      let drop = false;
      if (!state.mods.noRealmDrop && state.realmIdx > 0 && rng() < 0.18 + state.realmIdx*0.03){
        state.realmIdx -= 1;
        drop = true;
      }

      // consolation: chance to gain scroll and points
      const scrollGain = (rng() < 0.35 + state.stats.wuxing/280) ? (1 + (state.mods.scrollOnFail||0)) : 0;
      if (scrollGain){ state.res.scroll += scrollGain; }
      const pts = 6 + rng()*6;
      state.daoPoints += pts;

      log(`闭关冲关：破境失败。反噬 -${backlash} 体魄${drop?`，境界跌落至「${REALMS[state.realmIdx].name}」`:''}${scrollGain?`，悟得残页×${scrollGain}`:''}。`, 'bad');
      beep('sine', 190, .10, .03);
      showModal('破境未成', `
        <p>你强行冲关，气机逆乱，反噬入体。</p>
        <p><b>补偿：</b>道点 +${pts.toFixed(1)}${scrollGain?`，残页 +${scrollGain}`:''}。</p>
        <p class="muted">（成功率：${Math.floor(chance*100)}%${usedPill?'，已用丹':''}${usedScroll?'，已用残页':''}）</p>
      `);
    }

    // ensure mods consistent if realm dropped
    recomputeMods();
    render();
  }

  /*** Actions ***/
  function meditate(){
    // burst aura based on mp and stance (if in run)
    const base = 120 + state.arrayLv*45 + state.stats.wuxing*4;
    let mult = 1;
    if (state.run.active) mult = 0.55;
    const gain = Math.floor(base * mult);
    state.res.aura += gain;
    state.realmProg = clamp(state.realmProg + gain*0.18, 0, realmNeed());
    log(`你打坐吐纳，灵气 +${gain}。`, 'good');
    beep('triangle', 560, .06, .018);
    render();
  }

  function upgradeArray(){
    const cost = arrayCost();
    if (state.res.stone < cost){
      log(`灵石不足：需 ${cost}。`, 'bad');
      beep('sine', 260, .05, .02);
      return;
    }
    state.res.stone -= cost;
    state.arrayLv += 1;
    state.daoPoints += 2.5;
    log(`洞府灵阵升阶：第 ${state.arrayLv} 阶（耗灵石 ${cost}）。`, 'good');
    chord();
    render();
  }

  function showHelp(){
    showModal('指引 · 玄穹问道', `
      <p><b>核心循环：</b>吐纳积累灵气 → 参悟功法与升阶灵阵 → 入秘境夺资源 → 闭关突破境界。</p>
      <ul>
        <li><b>吐纳速率</b>受灵根、悟性、灵阵与功法影响。</li>
        <li><b>秘境</b>为轻量 Roguelite：每层随机节点（战斗/奇遇/商队/机缘/休整），最终挑战魇主。</li>
        <li><b>姿态</b>影响战斗：<b>凌厉</b>高伤易伤、<b>守拙</b>稳健、<b>玄诡</b>偏真元与暴击、<b>中正</b>均衡。</li>
        <li><b>突破</b>需要大量灵气与灵材；成功率与悟性、气运、神识、灵阵阶、功法有关。</li>
        <li><b>炼丹/炼器</b>可增强续航与战斗；法器耐久会在秘境中消耗。</li>
        <li><b>存档</b>自动保存于浏览器本地，可导出/导入 JSON。</li>
      </ul>
      <p class="muted">提示：若想快速起势，优先参悟「太初吐纳」与「星纹聚灵阵」，再进入秘境换取灵材与残页。</p>
    `);
  }

  /*** Export/Import/Reset ***/
  function exportSave(){
    const data = JSON.stringify(state);
    const blob = new Blob([data], {type:'application/json'});
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `xuanqiong_wendao_save_${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
    log('存档已导出。', 'good');
    beep('triangle', 820, .06, .02);
  }

  function importSave(){
    const inp = document.createElement('input');
    inp.type='file';
    inp.accept='application/json';
    inp.onchange = async ()=>{
      const file = inp.files?.[0];
      if (!file) return;
      const text = await file.text();
      try{
        const obj = JSON.parse(text);
        if (!obj || !obj.version) throw new Error('bad');
        state = obj;
        recomputeMods();
        saveState();
        log('存档已导入。', 'good');
        chord();
        render();
      }catch{
        log('导入失败：存档格式无效。', 'bad');
        beep('sine', 220, .12, .03);
      }
    };
    inp.click();
  }

  function resetGame(){
    localStorage.removeItem(STORAGE_KEY);
    state = defaultState();
    saveState();
    log('命格已重铸。', 'normal');
    chord();
    render();
  }

  /*** Achievements check ***/
  function checkAchs(){
    let newOnes = 0;
    for (const a of ACHS){
      const done = !!state.achs[a.id] || a.test(state);
      if (done && !state.achs[a.id]){
        state.achs[a.id] = true;
        newOnes++;
      }
    }
    if (newOnes>0){
      log(`命格回响：解锁成就 ×${newOnes}。`, 'good');
      beep('triangle', 920, .08, .02);
    }
  }

  /*** UI bindings ***/
  $('#btnMeditate').addEventListener('click', meditate);
  $('#btnArray').addEventListener('click', upgradeArray);
  $('#btnStudy').addEventListener('click', ()=>{
    showModal('参悟功法', '<p>功法玄图位于左侧「功法 · 玄图」。积累道点后，可逐步解锁更深的玄术。</p>');
  });

  $('#btnEnter').addEventListener('click', startRun);
  $('#btnStep').addEventListener('click', ()=>{ state.run.pendingEvent=null; stepRun(); });
  $('#btnRest').addEventListener('click', ()=>restRun(true));
  $('#btnExit').addEventListener('click', ()=>endRun('自行退隐'));

  $('#btnBreak').addEventListener('click', breakthrough);

  $('#btnAlchemy').addEventListener('click', ()=>{
    showModal('炼丹', '<p>右侧「炼丹」可将灵材与灵石炼为丹药，丹药能增强调息与突破。</p>');
  });
  $('#btnForge').addEventListener('click', ()=>{
    showModal('炼器', '<p>右侧「炼器」可打造法器，提升秘境战斗表现。法器有耐久，会逐步磨损。</p>');
  });

  $('#btnHelp').addEventListener('click', showHelp);
  $('#btnExport').addEventListener('click', exportSave);
  $('#btnImport').addEventListener('click', importSave);
  $('#btnReset').addEventListener('click', ()=>{
    showModal('重铸命格', `
      <p>这将清空本地存档，重新生成灵根与初始属性。</p>
      <div class="muted">建议先导出存档。</div>
      <div style="margin-top:12px; display:flex; gap:10px; justify-content:flex-end">
        <button id="confirmReset" class="btn danger">确认重铸</button>
      </div>
    `);
    setTimeout(()=>{
      const b = $('#confirmReset');
      if (b) b.addEventListener('click', ()=>{ hideModal(); resetGame(); });
    }, 0);
  });

  $('#btnSound').addEventListener('click', ()=>{
    state.soundOn = !state.soundOn;
    soundOn = state.soundOn;
    saveState();
    render();
    beep('triangle', soundOn?880:220, .06, .02);
  });

  $$('.stance').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      $$('.stance').forEach(b=>b.classList.remove('active'));
      btn.classList.add('active');
      state.run.stance = btn.dataset.stance;
      log(`你切换战斗姿态：${btn.textContent}。`, 'normal');
      beep('triangle', 520, .05, .015);
      render();
    });
  });

  /*** Background canvas starfield ***/
  function initBg(){
    const canvas = $('#bg');
    const ctx = canvas.getContext('2d');
    let w=0,h=0;

    const stars = [];
    const dust = [];

    function resize(){
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      w = canvas.width = Math.floor(window.innerWidth * dpr);
      h = canvas.height = Math.floor(window.innerHeight * dpr);
      canvas.style.width = window.innerWidth+'px';
      canvas.style.height = window.innerHeight+'px';

      stars.length = 0;
      dust.length = 0;
      const n = Math.floor((window.innerWidth * window.innerHeight) / 14000);
      const m = Math.floor((window.innerWidth * window.innerHeight) / 9000);
      const rng = mulberry32(state.seed ^ 0x515151);

      for (let i=0;i<n;i++){
        stars.push({
          x: rng()*w,
          y: rng()*h,
          r: 0.6 + rng()*1.6,
          a: 0.12 + rng()*0.55,
          s: 0.04 + rng()*0.12,
          c: rng() < 0.15 ? 'gold' : 'ice'
        });
      }
      for (let i=0;i<m;i++){
        dust.push({
          x: rng()*w,
          y: rng()*h,
          r: 1 + rng()*2.6,
          a: 0.03 + rng()*0.06,
          vx: (rng()-0.5) * 0.06,
          vy: (rng()-0.5) * 0.06,
        });
      }
    }

    function draw(t){
      ctx.clearRect(0,0,w,h);

      // gradient haze
      const g = ctx.createRadialGradient(w*0.2, h*0.15, 0, w*0.2, h*0.15, Math.max(w,h)*0.8);
      g.addColorStop(0, 'rgba(203,178,106,0.10)');
      g.addColorStop(0.5, 'rgba(127,214,255,0.06)');
      g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g;
      ctx.fillRect(0,0,w,h);

      // dust
      for (const p of dust){
        p.x += p.vx * (1 + Math.sin(t/4000));
        p.y += p.vy * (1 + Math.cos(t/4200));
        if (p.x<0) p.x+=w; if (p.x>w) p.x-=w;
        if (p.y<0) p.y+=h; if (p.y>h) p.y-=h;
        ctx.beginPath();
        ctx.fillStyle = `rgba(255,255,255,${p.a})`;
        ctx.arc(p.x,p.y,p.r,0,Math.PI*2);
        ctx.fill();
      }

      // stars twinkle
      for (const s of stars){
        const tw = 0.55 + 0.45*Math.sin(t/1000 * s.s + s.x*0.001);
        const a = s.a * tw;
        ctx.beginPath();
        const col = s.c==='gold' ? `rgba(203,178,106,${a})` : `rgba(160,220,255,${a})`;
        ctx.fillStyle = col;
        ctx.arc(s.x, s.y, s.r, 0, Math.PI*2);
        ctx.fill();
      }

      requestAnimationFrame(draw);
    }

    window.addEventListener('resize', resize);
    resize();
    requestAnimationFrame(draw);
  }

  /*** Startup ***/
  recomputeMods();
  initBg();
  render();
  log('洞府灯火微明，你的道途自此展开。', 'normal');
  requestAnimationFrame(tick);

  // register service worker (optional offline)
  if ('serviceWorker' in navigator){
    window.addEventListener('load', ()=>{
      navigator.serviceWorker.register('./sw.js').catch(()=>{});
    });
  }

})();
