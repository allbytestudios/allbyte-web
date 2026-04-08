<script>
  /** @type {{ name: string, file: string }[]} */
  let tracks = $state([]);
  let currentIndex = $state(-1);
  let isPlaying = $state(false);
  let volume = $state(0.7);
  let isVisible = $state(false);
  let looping = $state(true);

  /** @type {HTMLAudioElement | undefined} */
  let audio = $state(undefined);

  let currentTrack = $derived(currentIndex >= 0 && currentIndex < tracks.length ? tracks[currentIndex] : null);

  function formatName(name) {
    return name
      .replace(/([A-Z])/g, " $1")
      .replace(/(\d+)/g, " $1")
      .replace(/_/g, " ")
      .replace(/^rest zapsplat.*/, "Rest Theme")
      .trim();
  }

  function play(index) {
    if (index < 0 || index >= tracks.length) return;
    currentIndex = index;
    isPlaying = true;
    isVisible = true;
    // Wait for reactivity to update audio src
    queueMicrotask(() => {
      if (audio) {
        audio.load();
        audio.play().catch(() => {});
      }
    });
  }

  function toggle() {
    if (!audio || !currentTrack) return;
    if (isPlaying) {
      audio.pause();
    } else {
      audio.play().catch(() => {});
    }
    isPlaying = !isPlaying;
  }

  function next() {
    if (tracks.length === 0) return;
    play((currentIndex + 1) % tracks.length);
  }

  function prev() {
    if (tracks.length === 0) return;
    play((currentIndex - 1 + tracks.length) % tracks.length);
  }

  function close() {
    if (audio) audio.pause();
    isPlaying = false;
    isVisible = false;
  }

  function onEnded() {
    if (looping && audio) {
      audio.currentTime = 0;
      audio.play().catch(() => {});
    } else {
      next();
    }
  }

  function onVolumeChange(e) {
    volume = Number(e.target.value) / 100;
    if (audio) audio.volume = volume;
  }

  // Save state to sessionStorage so it survives page navigations
  function saveState() {
    if (tracks.length === 0) return;
    sessionStorage.setItem("music-player", JSON.stringify({
      tracks,
      currentIndex,
      isPlaying,
      volume,
      isVisible,
      currentTime: audio?.currentTime ?? 0,
    }));
  }

  // Restore state from sessionStorage on mount
  function restoreState() {
    try {
      const raw = sessionStorage.getItem("music-player");
      if (!raw) return;
      const state = JSON.parse(raw);
      if (!state.tracks?.length || !state.isVisible) return;
      tracks = state.tracks;
      currentIndex = state.currentIndex;
      volume = state.volume ?? 0.7;
      isVisible = true;
      // Resume playback after audio element is ready
      queueMicrotask(() => {
        if (audio) {
          audio.volume = volume;
          audio.currentTime = state.currentTime ?? 0;
          if (state.isPlaying) {
            audio.play().then(() => { isPlaying = true; }).catch(() => { isPlaying = false; });
          }
        }
      });
    } catch {}
  }

  // Listen for events from the music page
  function handleLoadTracks(e) {
    tracks = e.detail.tracks;
    play(e.detail.index ?? 0);
  }

  function handlePlayTrack(e) {
    const idx = e.detail.index;
    if (idx >= 0 && idx < tracks.length) {
      play(idx);
    }
  }

  $effect(() => {
    window.addEventListener("music-player:load", handleLoadTracks);
    window.addEventListener("music-player:play", handlePlayTrack);
    window.addEventListener("beforeunload", saveState);
    restoreState();

    return () => {
      window.removeEventListener("music-player:load", handleLoadTracks);
      window.removeEventListener("music-player:play", handlePlayTrack);
      window.removeEventListener("beforeunload", saveState);
    };
  });

  // Also save when navigating via clicks (beforeunload doesn't always fire for same-origin nav)
  $effect(() => {
    function onClickSave() { saveState(); }
    document.addEventListener("click", (e) => {
      const a = /** @type {HTMLElement} */ (e.target).closest("a[href]");
      if (a) saveState();
    });
  });

  // Sync volume when audio element mounts
  $effect(() => {
    if (audio) audio.volume = volume;
  });

  // Expose playing state so other components can check it
  $effect(() => {
    window.__musicPlayerPlaying = isPlaying && isVisible;
    window.__musicPlayerIndex = currentIndex;
  });

  // Notify music page when track changes
  $effect(() => {
    if (currentIndex >= 0) {
      window.dispatchEvent(new CustomEvent("music-player:track-changed", {
        detail: { index: currentIndex }
      }));
    }
  });
</script>

{#if isVisible && currentTrack}
  <div class="music-player">
    <audio
      bind:this={audio}
      src={currentTrack.file}
      onended={onEnded}
      preload="metadata"
    ></audio>

    <div class="player-bar">
      <button class="player-btn" onclick={prev} title="Previous song">&laquo;</button>
      <button class="player-btn play-btn" onclick={toggle} title={isPlaying ? "Pause" : "Play"}>
        {isPlaying ? "\u275A\u275A" : "\u25B6"}
      </button>
      <button class="player-btn" onclick={next} title="Next song">&raquo;</button>
      <button class="player-btn loop-btn" class:loop-active={looping} onclick={() => looping = !looping} title={looping ? "Loop: on" : "Loop: off"}>
        &#x21BB;
      </button>

      <a href="/music/" class="track-title" title="Go to music page">{formatName(currentTrack.name)}</a>

      <input
        type="range"
        class="vol-slider"
        min="0"
        max="100"
        value={Math.round(volume * 100)}
        oninput={onVolumeChange}
        title="Volume"
      />

      <button class="player-btn close-btn" onclick={close} title="Close">&times;</button>
    </div>
  </div>
{/if}

<style>
  .music-player {
    position: fixed;
    bottom: 1rem;
    right: 1rem;
    z-index: 9999;
    background: #141b24;
    border: 1px solid rgba(167, 243, 208, 0.25);
    border-radius: 8px;
    box-shadow: 0 4px 20px rgba(0, 0, 0, 0.5);
    min-width: 260px;
    max-width: 320px;
    font-family: "AllByteCustom", Georgia, "Times New Roman", serif;
    color: #e0e7ff;
    overflow: hidden;
  }

  .player-bar {
    display: flex;
    align-items: center;
    gap: 0.25rem;
    padding: 0.5rem 0.6rem;
  }

  .player-btn {
    background: none;
    border: none;
    color: #a7f3d0;
    cursor: pointer;
    font-size: 0.9rem;
    padding: 0.2rem 0.4rem;
    border-radius: 3px;
    transition: background 0.15s;
    font-family: inherit;
    line-height: 1;
  }

  .player-btn:hover {
    background: rgba(167, 243, 208, 0.1);
  }

  .play-btn {
    font-size: 1.1rem;
  }

  .track-title {
    flex: 1;
    font-size: 0.85rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    padding: 0 0.3rem;
    color: #e0e7ff;
    text-decoration: none;
    transition: color 0.15s;
  }

  .track-title:hover {
    color: #a7f3d0;
  }

  .close-btn {
    font-size: 1.1rem;
    color: #888;
    margin-left: auto;
  }

  .close-btn:hover {
    color: #e0e7ff;
  }

  .loop-btn {
    opacity: 0.4;
    font-size: 0.8rem;
  }

  .loop-active {
    opacity: 1;
  }

  .vol-slider {
    width: 60px;
    height: 4px;
    accent-color: #a7f3d0;
    cursor: pointer;
    flex-shrink: 0;
  }
</style>
