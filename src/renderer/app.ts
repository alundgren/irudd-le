/**
 * Renderer. Talks to the main process only through `window.overlay`, the API
 * defined in src/preload/index.ts. No Node, no direct Electron access -- the
 * renderer tsconfig omits Node types so that stays true by construction.
 */

interface PlannerNode {
  name: string;
  desc: string;
  rank: number;
  max: number;
}

interface PlannerGroup {
  title: string;
  nodes: PlannerNode[];
}

// --- Placeholder build data ------------------------------------------------
// Stands in for a real build planner. The shape (groups -> nodes with
// rank/max/desc) is roughly what actual skill and passive data will look like,
// so the layout is already proven against enough rows to scroll.
const node = (name: string, desc: string, rank: number, max: number): PlannerNode => ({
  name,
  desc,
  rank,
  max,
});

const BUILD: PlannerGroup[] = [
  {
    title: 'Paladin — Passives',
    nodes: [
      node('Conviction', 'Increased damage and healing effectiveness', 8, 8),
      node('Holy Symbol', 'Ward gain on hit while blocking', 5, 5),
      node('Prayer', 'Health regen, scales with attunement', 6, 8),
      node('Penance', 'Heal on melee hit', 4, 6),
      node('Devotion', 'Reduced mana cost of holy skills', 3, 5),
      node('Shield of Fire', 'Fire damage reflected while blocking', 0, 5),
    ],
  },
  {
    title: 'Smite — Specialisation',
    nodes: [
      node('Volatile Currents', 'Chance to cast on hit', 1, 1),
      node('Sigils of Hope', 'Generates sigils that boost healing', 4, 4),
      node('Rebuke', 'Stun chance against bosses', 2, 4),
      node('Static', 'Lightning damage over time', 5, 5),
      node('Divine Bolt', 'Extra projectile per cast', 0, 3),
    ],
  },
  {
    title: 'Gear priorities',
    nodes: [
      node('Helmet', 'Vitality, health, fire resist', 3, 3),
      node('Body armour', 'Health, armour, void resist', 2, 3),
      node('Relic', 'Increased ward retention', 1, 3),
      node('Amulet', 'Attunement, healing effectiveness', 2, 3),
      node('Rings', 'Crit avoidance until capped', 0, 3),
      node('Boots', 'Movement speed, dodge', 1, 3),
      node('Gloves', 'Melee attack speed', 0, 3),
      node('Belt', 'Potion health, health', 0, 3),
    ],
  },
  {
    title: 'Leveling checklist',
    nodes: [
      node('Cap fire resist', 'Before Chapter 6', 1, 1),
      node('Cap void resist', 'Before Empowered Monoliths', 0, 1),
      node('75% crit avoidance', 'Highest priority once level 80', 0, 1),
      node('Idol slots filled', 'Prefer ward-per-second idols', 0, 1),
    ],
  },
];

const NOTES: string[] = [
  'Toggle interactive mode before clicking anything in here.',
  'The game must run in borderless windowed mode — exclusive fullscreen owns the display and nothing can draw above it.',
  'Drag the title bar to move the overlay while in interactive mode.',
  'Scroll this panel to confirm the overlay swallows scroll events only when interactive.',
];

// --- Helpers ---------------------------------------------------------------

/** Every id below is in index.html, so a miss is a bug worth throwing on. */
function must<T extends Element = HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`[overlay] missing #${id} in index.html`);
  return el as unknown as T;
}

// --- Rendering -------------------------------------------------------------

function renderBuild(container: HTMLElement): void {
  const frag = document.createDocumentFragment();

  for (const group of BUILD) {
    const heading = document.createElement('h2');
    heading.className = 'group-title';
    heading.textContent = group.title;
    frag.append(heading);

    for (const item of group.nodes) {
      const row = document.createElement('div');
      row.className = item.rank >= item.max ? 'node is-done' : 'node';

      const label = document.createElement('div');
      label.className = 'node-name';
      label.textContent = item.name;

      const sub = document.createElement('small');
      sub.className = 'node-desc';
      sub.textContent = item.desc;
      label.append(sub);

      const rank = document.createElement('span');
      rank.className = 'node-rank';
      rank.textContent = `${item.rank}/${item.max}`;

      row.append(label, rank);
      frag.append(row);
    }
  }

  container.replaceChildren(frag);
}

function renderNotes(list: HTMLElement): void {
  list.replaceChildren(
    ...NOTES.map((text) => {
      const li = document.createElement('li');
      li.textContent = text;
      return li;
    })
  );
}

// --- Tabs ------------------------------------------------------------------

function wireTabs(): void {
  const tabs = must('tabs');
  const panels = Array.from(document.querySelectorAll<HTMLElement>('.panel'));

  tabs.addEventListener('click', (event) => {
    const target = event.target as HTMLElement | null;
    const tab = target?.closest<HTMLButtonElement>('.tab');
    if (!tab || tab.disabled) return;

    for (const other of tabs.querySelectorAll('.tab')) {
      other.classList.toggle('is-active', other === tab);
    }
    for (const panel of panels) {
      panel.classList.toggle(
        'is-active',
        panel.dataset.panel === tab.dataset.panel
      );
    }
  });
}

// --- Interaction mode ------------------------------------------------------

function applyMode(state: OverlayState): void {
  document.body.dataset.mode = state.interactive
    ? 'interactive'
    : 'click-through';
  must('mode-label').textContent = state.interactive
    ? 'interactive'
    : 'click-through';
}

function wireControls(): void {
  must('passthrough-btn').addEventListener('click', () => {
    void window.overlay.setInteractive(false);
  });

  must('quit-btn').addEventListener('click', () => {
    window.overlay.quit();
  });
}

// --- Boot ------------------------------------------------------------------

async function init(): Promise<void> {
  renderBuild(must('tree'));
  renderNotes(must('notes'));
  wireTabs();
  wireControls();

  window.overlay.onModeChanged(applyMode);

  const state = await window.overlay.getState();
  if (!state) return;

  applyMode(state);
  must('hint').textContent = `${state.shortcuts.toggleInteractive} toggles`;
}

void init();
