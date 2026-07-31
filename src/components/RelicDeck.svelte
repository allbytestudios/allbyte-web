<script>
  // Interactive relic codex: click through the demo's five relics. The stack is
  // a keyed circular list — on next/prev the order rotates and CSS transitions
  // carry each card to its new slot, so the front card recedes to the back and
  // the one beneath it comes forward. Skill copy is a first pass — confirm vs game.
  const RELICS = [
    { name: "Berserckounter Relic", type: "reaction", tiers: 4, icon: "/home/relics/Skill_Berserckounter.png",
      skill: "Raises the damage you take in place of the damage you deal.",
      frag: "The captain was usually a reasonable man…" },
    { name: "Scan Relic", type: "passive", tiers: 3, icon: "/home/relics/Skill_Scan.png",
      skill: "Reveals a foe’s stats and hidden weaknesses.",
      frag: "A plague has taken two lives a week for six weeks…" },
    { name: "Item Relic", type: "action", tiers: 5, icon: "/home/relics/Skill_Item.png",
      skill: "Use items from your bag in the thick of battle.",
      frag: "An early winter blizzard came down on the sixth day of the cold snap…" },
    { name: "Health Relic", type: "passive", tiers: 4, icon: "/home/relics/Skill_Health.png",
      skill: "Strengthens the bearer’s vitality.",
      frag: "We broke on level ground, nothing behind me but wounded men walking slow…" },
    { name: "Move Relic", type: "passive", tiers: 4, icon: "/home/relics/Skill_Move.png",
      skill: "Carries the bearer farther across the field.",
      frag: "We had the tent up two days in a town that never much liked us having it up…" },
  ];
  const TYPE = {
    action:   { label: "Action",   c: "var(--t-action)" },
    reaction: { label: "Reaction", c: "var(--t-reaction)" },
    passive:  { label: "Passive",  c: "var(--t-passive)" },
  };
  const ROMAN = ["", "Ⅰ", "Ⅱ", "Ⅲ", "Ⅳ", "Ⅴ"];
  const N = RELICS.length;

  let order = $state([0, 1, 2, 3, 4]); // front → back
  let busy = $state(false);
  const front = $derived(order[0]);

  function settle() { setTimeout(() => (busy = false), 430); }
  function next() { if (busy) return; busy = true; order = [...order.slice(1), order[0]]; settle(); }
  function prev() { if (busy) return; busy = true; order = [order[N - 1], ...order.slice(0, N - 1)]; settle(); }
  function go(ri) {
    if (busy) return;
    const pos = order.indexOf(ri);
    if (pos === 0) return;
    busy = true;
    order = [...order.slice(pos), ...order.slice(0, pos)];
    settle();
  }
</script>

<div class="relicdeck">
  <div class="deck">
    {#each order as ri, slot (ri)}
      <button class="card" class:front={slot === 0} style={`--slot:${slot}; --tc:${TYPE[RELICS[ri].type].c}; z-index:${N - slot}`}
        onclick={next} tabindex={slot === 0 ? 0 : -1} aria-hidden={slot !== 0}
        aria-label={`${RELICS[ri].name} — click for the next relic`}>
        <span class="inner">
          <span class="type-tab">{TYPE[RELICS[ri].type].label}</span>
          <span class="medallion"><img src={RELICS[ri].icon} alt="" width="72" height="72" /></span>
          <span class="rname">{RELICS[ri].name}</span>
          <span class="rskill">{RELICS[ri].skill}</span>
          <span class="tiers">
            <span class="lbl">Expertise</span>
            {#each Array(RELICS[ri].tiers) as _, i}
              <span class="pip {i === 0 ? 'on' : ''}">{ROMAN[i + 1]}</span>
            {/each}
          </span>
          <span class="frag"><span class="q">&ldquo;</span>{RELICS[ri].frag}<span class="tier-note"> &mdash; Tier {ROMAN[1]} of {ROMAN[RELICS[ri].tiers]}</span></span>
        </span>
      </button>
    {/each}
  </div>

  <div class="controls">
    <button class="arrow" onclick={prev} aria-label="Previous relic">&lsaquo;</button>
    <div class="dots">
      {#each RELICS as r, i}
        <button class="dot {i === front ? 'active' : ''}" style={`--tc:${TYPE[r.type].c}`}
          onclick={() => go(i)} aria-label={r.name} aria-current={i === front}></button>
      {/each}
    </div>
    <button class="arrow" onclick={next} aria-label="Next relic">&rsaquo;</button>
  </div>

  <p class="count">Five relics wait hidden across <b>the demo</b></p>
  <div class="legend">
    <span><i style="background:var(--t-action)"></i>Action</span>
    <span><i style="background:var(--t-reaction)"></i>Reaction</span>
    <span><i style="background:var(--t-passive)"></i>Passive</span>
  </div>
</div>

<style>
  .relicdeck{
    --crimson:#8a2b21; --gilt:#9a7736; --gilt-deep:#6f5321; --ink:#3a2c1b; --ink-soft:#5b4a33;
    --panel:#efe6cd; --rule:#c9b78a; --paperblend:#e7dcbd; --shadow:rgba(60,40,15,.28);
    --t-action:#8a2b21; --t-reaction:#b6862c; --t-passive:#4f7a4a;
    display:flex; flex-direction:column; align-items:center;
    font-family:Georgia,"Times New Roman",serif; color:var(--ink);
  }
  .deck{ position:relative; width:290px; height:428px; }

  .card{
    position:absolute; top:14px; left:0; width:290px; height:410px;
    border-radius:8px; background:var(--panel); border:1px solid var(--gilt);
    box-shadow:0 10px 26px var(--shadow),inset 0 0 0 3px var(--paperblend),inset 0 0 0 4px var(--rule);
    padding:0; text-align:center; font:inherit; color:inherit; cursor:default; pointer-events:none;
    transform-origin:center 70%;
    transform:
      translateX(calc(var(--slot) * 5px))
      translateY(calc(var(--slot) * -9px))
      rotate(calc(var(--slot) * 1.5deg))
      scale(calc(1 - var(--slot) * 0.035));
    transition:transform .42s cubic-bezier(.33,.02,.23,1);
  }
  .card::before{ content:""; position:absolute; top:0; left:0; right:0; height:7px; border-radius:8px 8px 0 0; background:var(--tc,#999); }
  .card.front{ cursor:pointer; pointer-events:auto; }
  .card.front:hover{ transform:translateY(-4px); box-shadow:0 16px 34px var(--shadow),inset 0 0 0 3px var(--paperblend),inset 0 0 0 4px var(--rule); }
  .card.front:focus-visible{ outline:2px solid var(--crimson); outline-offset:4px; }

  .inner{ position:absolute; inset:0; padding:20px 20px 18px; display:flex; flex-direction:column; align-items:center; }
  /* only the front card's text shows; backs are dimmed so they read as blank stock */
  .card:not(.front) .inner{ opacity:0; transition:opacity .3s; }
  .card.front .inner{ opacity:1; transition:opacity .3s .12s; }

  .type-tab{ text-transform:uppercase; letter-spacing:.16em; font-size:.62rem; font-weight:700; color:#fff;
    background:var(--tc); padding:.24rem .7rem; border-radius:2px; margin-top:.2rem; }
  .medallion{ width:104px; height:104px; border-radius:50%; margin:.85rem 0 .5rem; display:flex; align-items:center; justify-content:center;
    background:radial-gradient(circle at 50% 40%,#f6eecd,#e3d5ac); border:3px solid var(--gilt);
    box-shadow:inset 0 0 12px rgba(111,83,33,.35),0 2px 6px var(--shadow); }
  .medallion img{ width:68px; height:68px; image-rendering:pixelated; }
  .rname{ font-size:1.3rem; color:var(--crimson); font-weight:700; margin-top:.1rem; line-height:1.1; }
  .rskill{ font-size:.9rem; color:var(--ink-soft); font-style:italic; margin:.3rem 0 .55rem; }
  .tiers{ display:flex; gap:.3rem; align-items:center; margin-bottom:.55rem; flex-wrap:wrap; justify-content:center; }
  .tiers .lbl{ font-size:.56rem; text-transform:uppercase; letter-spacing:.14em; color:var(--gilt-deep); margin-right:.1rem; }
  .pip{ width:15px; height:15px; border-radius:50%; border:1.5px solid var(--gilt-deep); display:flex; align-items:center; justify-content:center; font-size:.48rem; color:var(--gilt-deep); }
  .pip.on{ background:var(--tc); border-color:var(--tc); color:#fff; }
  .frag{ font-size:.82rem; color:var(--ink); line-height:1.5; font-style:italic; border-top:1px solid var(--rule); padding-top:.55rem; margin-top:auto; }
  .frag .q{ color:var(--gilt-deep); font-size:1.3rem; line-height:0; vertical-align:-.2em; margin-right:.05rem; }
  .tier-note{ color:var(--gilt-deep); font-style:normal; }

  .controls{ display:flex; align-items:center; gap:.9rem; margin-top:1.4rem; }
  .arrow{ background:none; border:1px solid var(--gilt); color:var(--crimson); width:30px; height:30px; border-radius:50%;
    font-size:1.2rem; line-height:1; cursor:pointer; display:flex; align-items:center; justify-content:center; transition:.15s; }
  .arrow:hover{ background:var(--paperblend); }
  .arrow:focus-visible{ outline:2px solid var(--crimson); outline-offset:2px; }
  .dots{ display:flex; gap:.5rem; }
  .dot{ width:11px; height:11px; border-radius:50%; border:1.5px solid var(--gilt-deep); background:transparent; cursor:pointer; padding:0; transition:.15s; }
  .dot.active{ background:var(--tc); border-color:var(--tc); transform:scale(1.15); }
  .dot:focus-visible{ outline:2px solid var(--crimson); outline-offset:2px; }

  .count{ text-transform:uppercase; letter-spacing:.14em; font-size:.8rem; color:var(--gilt-deep); margin:1.3rem 0 0; }
  .count b{ color:var(--crimson); }
  .legend{ display:flex; gap:1.1rem; justify-content:center; margin-top:.7rem; font-size:.72rem; color:var(--ink-soft); }
  .legend span{ display:inline-flex; align-items:center; gap:.35rem; }
  .legend i{ width:11px; height:11px; border-radius:2px; display:inline-block; }

  @media (prefers-reduced-motion:reduce){
    .card,.card .inner,.arrow,.dot{ transition:none; }
  }
</style>
