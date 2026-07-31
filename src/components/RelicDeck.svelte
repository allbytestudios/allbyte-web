<script>
  // Interactive relic codex: click through the demo's five relics. Data is
  // static (icon + type + skill + expertise tiers + a story-fragment teaser);
  // skill copy is a first pass — confirm against the game.
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

  let current = $state(0);
  const go = (i) => { current = (i + RELICS.length) % RELICS.length; };
  const next = () => go(current + 1);
  const prev = () => go(current - 1);
</script>

<div class="relicdeck">
  <div class="deck">
    <!-- decorative fanned back cards: signal there are several -->
    <div class="card back b3" style="--tc:var(--t-passive)"></div>
    <div class="card back b2" style="--tc:var(--t-action)"></div>
    <div class="card back b1" style="--tc:var(--t-passive)"></div>

    <button class="card front" style={`--tc:${TYPE[RELICS[current].type].c}`} onclick={next}
      aria-label={`${RELICS[current].name} — click for the next relic`}>
      {#key current}
        <div class="inner">
          <span class="type-tab">{TYPE[RELICS[current].type].label}</span>
          <span class="medallion"><img src={RELICS[current].icon} alt="" width="72" height="72" /></span>
          <span class="rname">{RELICS[current].name}</span>
          <span class="rskill">{RELICS[current].skill}</span>
          <span class="tiers">
            <span class="lbl">Expertise</span>
            {#each Array(RELICS[current].tiers) as _, i}
              <span class="pip {i === 0 ? 'on' : ''}">{ROMAN[i + 1]}</span>
            {/each}
          </span>
          <span class="frag"><span class="q">&ldquo;</span>{RELICS[current].frag}<span class="tier-note"> &mdash; Tier {ROMAN[1]} of {ROMAN[RELICS[current].tiers]}</span></span>
        </div>
      {/key}
    </button>
  </div>

  <div class="controls">
    <button class="arrow" onclick={prev} aria-label="Previous relic">&lsaquo;</button>
    <div class="dots">
      {#each RELICS as r, i}
        <button class="dot {i === current ? 'active' : ''}" style={`--tc:${TYPE[r.type].c}`}
          onclick={() => go(i)} aria-label={r.name} aria-current={i === current}></button>
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
  .deck{ position:relative; width:290px; height:410px; }
  .card{ position:absolute; inset:0; border-radius:8px; background:var(--panel);
    border:1px solid var(--gilt); box-shadow:0 10px 26px var(--shadow),inset 0 0 0 3px var(--paperblend),inset 0 0 0 4px var(--rule); }
  .card::before{ content:""; position:absolute; top:0; left:0; right:0; height:7px; border-radius:8px 8px 0 0; background:var(--tc,#999); }
  .back{ pointer-events:none; }
  .b3{ transform:translate(30px,22px) rotate(5.5deg); z-index:1; filter:brightness(.97); }
  .b2{ transform:translate(-20px,12px) rotate(-4deg); z-index:2; }
  .b1{ transform:translate(14px,7px) rotate(2.5deg); z-index:3; }
  .front{ z-index:4; transform:translate(0,-2px); cursor:pointer; padding:0; text-align:center;
    font:inherit; color:inherit; transition:transform .15s, box-shadow .2s; }
  .front:hover{ transform:translate(0,-6px); box-shadow:0 16px 34px var(--shadow),inset 0 0 0 3px var(--paperblend),inset 0 0 0 4px var(--rule); }
  .front:focus-visible{ outline:2px solid var(--crimson); outline-offset:4px; }

  .inner{ position:absolute; inset:0; padding:20px 20px 18px; display:flex; flex-direction:column; align-items:center;
    animation:rd-in .28s ease; }
  @keyframes rd-in{ from{ opacity:0; transform:translateY(6px); } to{ opacity:1; transform:none; } }

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

  .controls{ display:flex; align-items:center; gap:.9rem; margin-top:1.5rem; }
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

  @media (prefers-reduced-motion:reduce){ .inner{ animation:none; } .front,.arrow,.dot{ transition:none; } }
</style>
