<script lang="ts">
  /**
   * Per-scene findable-item checklist. Ticks persist locally and are shared with
   * the nav rail's progress via the walkthroughTicks store.
   *
   * `reach` and `missable` come from Quinn's frontmatter items[] — that's where
   * the optional/missable distinction lives, not in prose blocks.
   */
  import { onMount } from "svelte";
  import { ticks } from "../lib/walkthroughTicks.svelte";

  interface Item {
    name: string;
    where: string;
    reach: "main" | "optional";
    missable?: boolean;
  }

  let { code, items = [] as Item[] }: { code: string; items?: Item[] } = $props();

  onMount(() => ticks.load());

  let done = $derived(items.filter((i) => ticks.isTicked(code, i.name)).length);
</script>

{#if items.length}
  <div class="wt-check">
    <h4>
      Findable items
      <span class="count" class:all={done === items.length && items.length > 0}>
        {done}/{items.length}
      </span>
    </h4>
    <ul>
      {#each items as item}
        {@const on = ticks.isTicked(code, item.name)}
        <li class:on>
          <label>
            <input type="checkbox" checked={on} onchange={() => ticks.toggle(code, item.name)} />
            <span class="box" aria-hidden="true"></span>
            <span class="body">
              <span class="name">{item.name}</span>
              <span class="where">{item.where}</span>
            </span>
            {#if item.reach === "optional"}<span class="tag opt">optional</span>{/if}
            {#if item.missable}<span class="tag miss">missable</span>{/if}
          </label>
        </li>
      {/each}
    </ul>
  </div>
{/if}

<style>
  .wt-check {
    background: var(--heart-card-bg, #dbd0a0); border: 1.5px solid var(--heart-card-border, #7a6e52);
    border-radius: 5px; padding: 0.75rem 0.9rem 0.8rem; margin: 1.1rem 0;
  }
  h4 {
    margin: 0 0 0.5rem; font-family: "AllByteCustom", Georgia, "Times New Roman", serif; font-size: 0.9rem;
    color: var(--heart-accent, #3a3020); display: flex; align-items: baseline; gap: 0.5rem;
    letter-spacing: 0.02em; text-transform: uppercase;
  }
  .count { font-size: 0.75rem; color: var(--heart-accent-dim, #5a4d38); font-weight: normal; }
  .count.all { color: #3f6b3f; font-weight: bold; }
  ul { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 0.3rem; }
  label {
    display: flex; align-items: flex-start; gap: 0.55rem; cursor: pointer;
    padding: 0.25rem 0.15rem; border-radius: 3px;
  }
  label:hover { background: rgba(58, 48, 32, 0.06); }
  input { position: absolute; opacity: 0; width: 0; height: 0; }
  .box {
    width: 1.05rem; height: 1.05rem; flex: none; margin-top: 0.1rem; border-radius: 3px;
    border: 2px solid var(--heart-accent, #3a3020); background: #fdf6e3; position: relative;
  }
  input:focus-visible + .box { outline: 3px solid var(--heart-accent, #3a3020); outline-offset: 2px; }
  li.on .box { background: var(--heart-accent, #3a3020); }
  li.on .box::after {
    content: ""; position: absolute; left: 0.28rem; top: 0.04rem;
    width: 0.26rem; height: 0.56rem; border: solid #fdf6e3;
    border-width: 0 2.5px 2.5px 0; transform: rotate(45deg);
  }
  .body { display: flex; flex-direction: column; gap: 0.08rem; min-width: 0; flex: 1; }
  .name { font-weight: 600; color: var(--heart-text, #2a2218); font-size: 0.86rem; }
  .where { font-size: 0.76rem; color: var(--heart-accent-dim, #5a4d38); }
  li.on .name { text-decoration: line-through; opacity: 0.55; }
  li.on .where { opacity: 0.5; }
  .tag {
    font-size: 0.62rem; padding: 0.1rem 0.4rem; border-radius: 999px; flex: none;
    margin-top: 0.15rem; text-transform: uppercase; letter-spacing: 0.04em;
  }
  .opt { background: rgba(60, 110, 160, 0.16); color: #2c5580; }
  .miss { background: rgba(170, 60, 40, 0.16); color: #8f3323; }
</style>
