// The markup of one map, rendered into its shadow root (index.ts `mount`): the header with search, Scenarios, View and
// help, the stage the scene draws in, the panel, the status line. Every id is the map's own (its root scopes them), so
// two maps on a page do not collide. The project switcher (#project) stays hidden unless the site fills it.
export const MARKUP = `
<div class="app">
  <header class="top">
    <span class="brand" aria-label="Arch Map">arch<i>·</i>map</span>
    <select id="project" aria-label="Project" hidden></select>
    <div class="searchbox">
      <input id="q" type="search" placeholder="Find a component, endpoint or table" autocomplete="off" aria-label="Search" role="combobox" aria-autocomplete="list" aria-haspopup="listbox" aria-expanded="false" aria-controls="results">
      <ul id="results" role="listbox" aria-label="Search results" hidden></ul>
    </div>
    <div class="viewwrap">
      <button id="scbtn" class="btn ghost" aria-haspopup="true" aria-expanded="false" aria-controls="scmenu">Scenarios ▾</button>
      <div id="scmenu" hidden></div>
    </div>
    <div class="viewwrap">
      <button id="viewbtn" class="btn ghost" aria-haspopup="true" aria-expanded="false" aria-controls="viewmenu">View ▾</button>
      <div id="viewmenu" hidden>
        <div class="vm-h">Angle</div>
        <div class="seg"><button data-preset="iso">3D</button><button data-preset="top">Top</button><button data-preset="side">Side</button><button data-fit="1">Fit</button></div>
        <div class="vm-h">Block coloring</div>
        <div class="seg" id="tints"></div>
        <div class="vm-h">Layer spacing</div>
        <input id="gap" type="range" min="12" max="90" value="34" aria-label="Space between layers">
        <label class="vm-check"><input id="auto" type="checkbox" checked> Wheel autofocus</label>
        <label class="vm-check"><input id="pulses" type="checkbox" checked> Pulses on relations</label>
        <label class="vm-check"><input id="glow" type="checkbox" checked> Glow</label>
        <label class="vm-check"><input id="motion" type="checkbox" checked> Camera and layout motion</label>
      </div>
    </div>
    <button id="helpbtn" class="btn ghost" aria-controls="helpsheet" aria-expanded="false" aria-label="Controls and shortcuts" title="Controls and shortcuts (?)">?</button>
  </header>
  <div class="main">
    <div id="stage">
      <nav id="focusbar" aria-label="Where am I"></nav>
      <div id="legend"></div>
      <div id="card" hidden></div>
      <div id="toast" role="status" hidden></div>
      <div id="zoomhint" role="status" hidden></div>
      <div id="stepbar" hidden></div>
    </div>
    <aside id="panel"></aside>
    <div id="sr-status" class="sr-only" role="status" aria-live="polite"></div>
  </div>
  <footer id="status"></footer>
  <dialog id="helpsheet" aria-labelledby="hs-title"></dialog>
</div>
`;
