/**
 * Lazy Superheroes character mascots.
 *
 * Each character is a real IP character from the LazyVerse. Taglines,
 * success lines, and lazy-mode quips drive the dashboard mascot's
 * personality based on agent state (ready, playing, idle, paused).
 *
 * Extracted from AuthFlow.tsx so the dashboard + future delight passes
 * can import the same roster. AuthFlow re-exports from here for
 * backwards compat.
 *
 * The persisted character index lives in
 * `localStorage['lazylotto:characterIdx']` so the mascot follows a
 * user across pages — they pick (or get assigned) a character on
 * /auth, and the same character greets them on /dashboard.
 */

const IPFS_BASE =
  'https://lazysuperheroes.myfilebase.com/ipfs/QmXsG47eDFSwCA4Kpii3XGidHScbsApdAvPnF4aMTpi7KD';
// Filebase image optimization — resize to 256px, contain, auto format, sharpen.
// Dashboard mascot uses 512px variant via IMG_OPTS_LARGE for crispness.
const IMG_OPTS = '?img-width=256&img-height=256&img-fit=contain&img-format=auto&img-sharpen=1';
const IMG_OPTS_LARGE =
  '?img-width=512&img-height=512&img-fit=contain&img-format=auto&img-sharpen=1';

export interface LshCharacter {
  name: string;
  /** 256px optimized image for auth + small contexts. */
  img: string;
  /** 512px variant for the dashboard hero mascot slot. */
  imgLarge: string;
  /** Pre-auth / landing taglines — hype lines. */
  taglines: string[];
  /** Post-auth success lines — confirmation moments. */
  successLines: string[];
  /**
   * First-run onboarding lines. Shown in the hero quip area when
   * the user has just registered and has no balance yet. Each
   * character should teach the fund → play → withdraw loop IN
   * THEIR VOICE — this is where the brand personality lands
   * hardest because it's the first thing a new user reads from
   * their chosen character.
   */
  introLines: string[];
  /**
   * Funded-but-unplayed lines. Shown when the user has a positive
   * balance but has not triggered a play session yet — the "go
   * ahead, hit PLAY" nudge in the character's voice.
   */
  readyLines: string[];
  /** Lazy-mode quips the dashboard mascot says while the agent is idle. */
  lazyLines: string[];
  /** Quips when the operator has paused the agent (kill switch). */
  nappingLines: string[];
}

// Build a character with both image sizes from a single asset name.
function make(
  name: string,
  file: string,
  taglines: string[],
  successLines: string[],
  introLines: string[],
  readyLines: string[],
  lazyLines: string[],
  nappingLines: string[],
): LshCharacter {
  return {
    name,
    img: `${IPFS_BASE}/${file}${IMG_OPTS}`,
    imgLarge: `${IPFS_BASE}/${file}${IMG_OPTS_LARGE}`,
    taglines,
    successLines,
    introLines,
    readyLines,
    lazyLines,
    nappingLines,
  };
}

export const LSH_CHARACTERS: LshCharacter[] = [
  // ── Gen 1 — Lazy Superheroes (Male) ──────────────────────────
  make(
    'Aadan',
    'Aadan.png',
    ['Aadan is ready. Are you?', 'Aadan says: fortune favours the bold.', 'Aadan has a good feeling about this.'],
    ["Aadan says: you're in! Let's roll.", 'Aadan approves. Welcome aboard.', 'Nice one. Aadan knew you had it in you.'],
    ["Hey. I'm Aadan. Here's how it works: you send tokens, I play the lottery, you keep the winnings. Three steps. I handle step two.", 'New here? I got you. Fund me below, I run the plays, you pull out whenever. Trust the process.'],
    ["Alright — I'm loaded. Hit Play whenever you're feeling lucky.", 'Ready when you are. Say the word and I roll.'],
    ['Aadan has this under control. Go grab a coffee.', 'Aadan will handle it. That\u2019s what he\u2019s here for.', 'Aadan says: sit back. Relax. Let the pro work.'],
    ['Aadan is taking five. Back soon.', 'Aadan is resting. Orders from the boss.'],
  ),
  make(
    'Jazz',
    'Jazz.png',
    ['Jazz says: let the good times roll.', 'Jazz is tuned in and ready.', 'Jazz has the rhythm of luck.'],
    ["Jazz says: you're in! Let's roll.", 'Jazz approves. Time to play.', 'Welcome to the LazyVerse, courtesy of Jazz.'],
    ["Jazz here. Three-note melody: you fund, I play, you cash out. I handle the solo, you enjoy the show.", "First time? Easy rhythm. Drop some HBAR in below, I riff on the pools, you pick up the winnings when you're ready."],
    ["The horns are warmed up. Hit Play and let's make some noise.", "Ready to jam. Tap Play when you feel the beat."],
    ['Jazz is freestyling. Don\u2019t interrupt the groove.', 'Jazz has you covered. Go put your feet up.', 'Jazz is in the zone. You can nap.'],
    ['Jazz is on break. The band rests between sets.', 'Jazz is paused. Tune back in soon.'],
  ),
  make(
    'Gordo',
    'Gordo.png',
    ["Gordo's got a feeling about this one.", 'Gordo never backs down from a bet.', 'Gordo says: go big or go home.'],
    ["Gordo says: you're in! Let's roll.", 'Gordo approves. Time to play.', 'Welcome to the big leagues, courtesy of Gordo.'],
    ["Gordo here. Three moves. You put up the stakes, I go big on the tables, you walk off with the pot. I'll be the loud one.", "New? Here's the deal: fund the pot below, I take the swings, you take the spoils. Simple."],
    ["Pot's loaded. Hit Play and let's make some noise.", "Chips are up. Ring the bell when you're ready, boss."],
    ['Gordo\u2019s got this. Seriously, go do nothing.', 'Gordo says: \u201Cyou rest, I play.\u201D That\u2019s the deal.', 'Gordo is on it. Doing things is overrated anyway.'],
    ['Gordo is snoozing. The boss said so.', 'Gordo is off the clock. Back in a bit.'],
  ),
  make(
    'Korgg',
    'Korgg.png',
    ['Korgg smash... those lottery odds.', 'Korgg is ready to rumble.', 'Korgg sees victory on the horizon.'],
    ["Korgg says: you're in! Let's roll.", 'Korgg approves. Time to smash.', 'Welcome to the LazyVerse, courtesy of Korgg.'],
    ["Korgg simple. You give Korgg tokens. Korgg smash lottery. You take winnings. Three steps. Korgg do hard one.", "Korgg say: deposit below. Korgg play. You rest. Easy like cave life."],
    ["Korgg ready. Korgg big. Hit button. Korgg smash.", "Korgg stretched. Korgg waiting. Say go, Korgg go."],
    ['Korgg handle lottery. You handle nap.', 'Korgg strong. Korgg play. You rest.', 'Korgg is working. Korgg is also napping. Korgg does both.'],
    ['Korgg sleep now. Korgg play later.', 'Korgg on break. Do not poke Korgg.'],
  ),
  make(
    'Nobody',
    'Nobody.png',
    ['Nobody does it better.', 'Nobody sees all. Nobody knows all.', 'Nobody is watching your back.'],
    ["Nobody says: you're in! Let's roll.", 'Nobody approves. Silently.', 'Welcome aboard. Nobody saw a thing.'],
    ["Nobody runs three errands: receives deposits, plays quietly, returns winnings. You'll barely notice I'm here. That's the point.", "New arrangement: fund below, I handle the plays nobody sees, you withdraw when you want. Discreet."],
    ["Nobody is ready. Hit Play and nobody will complain.", "The vault is stocked. Nobody is waiting for your signal."],
    ['Nobody is working on it. You wouldn\u2019t notice anyway.', 'Nobody has it covered. As usual.', 'Nobody suggests you go do nothing. It\u2019s what Nobody does best.'],
    ['Nobody is off. Nobody is watching. Nobody will be back.', 'Nobody rests. Nobody waits.'],
  ),
  make(
    'Kjell',
    'Kjell.png',
    ['The HBARBarian is feeling lucky.', 'Kjell sharpens his axe for fortune.', 'Kjell charges into the fray.'],
    ["Kjell says: you're in! Let's roll.", 'The HBARBarian approves. Onward.', 'Welcome to Valhalla, courtesy of Kjell.'],
    ["The HBARBarian has a code: you fund the war chest, I raid the pools, you take the spoils. Three acts of any good saga.", "New to the clan? Simple warrior's path. Send gold below, I swing the axe, you feast on winnings. Aye."],
    ["War chest filled. The HBARBarian is itching. Hit Play and let me fight.", "The axe is sharpened. Say the word, raider."],
    ['Kjell battles for you. Rest in the mead hall.', 'The HBARBarian fights while you feast.', 'Kjell says: warriors also need naps.'],
    ['Kjell is in the longhouse. Back to battle later.', 'The HBARBarian rests his axe. For now.'],
  ),
  make(
    'Crawford',
    'Crawford.png',
    ['Crawford always plays it cool.', 'Crawford has the odds figured out.', 'Crawford says: trust the process.'],
    ["Crawford says: you're in! Let's roll.", 'Crawford approves. Smooth move.', 'Welcome to the LazyVerse, courtesy of Crawford.'],
    ["Crawford here. Three smooth moves: you drop tokens below, I work the tables with style, you collect whenever. Effortless.", "First time? Don't sweat it. Fund below, I handle the hustle, you keep the cool. Easy."],
    ["All gassed up. Hit Play when you're feeling it, friend.", "Crawford is ready. Smooth call away."],
    ['Crawford\u2019s got this. Trust the process.', 'Crawford is cool. You be cool. Go do nothing.', 'Crawford says: effort is for amateurs.'],
    ['Crawford is off the clock. Catch him later.', 'Crawford is resting. Cool guys need cool downs.'],
  ),
  // ── Gen 1 — Lazy Superheroes (Female) ─────────────────────────
  make(
    'Ginnie Delice',
    'Ginnie-Delice.png',
    ['Ginnie says: fortune favours the bold.', 'Ginnie has a trick up her sleeve.', 'Ginnie Delice is feeling generous.'],
    ["Ginnie says: you're in! Let's roll.", 'Ginnie approves. Deliciously.', 'Welcome to the LazyVerse, courtesy of Ginnie.'],
    ["Ginnie here, darling. The recipe is simple: you drop ingredients (tokens) below, I cook up plays, you savour the results. Three-course meal.", "First time in the bakery? Fund the pantry below, I'll bake the wins, you taste them whenever. Deliciously simple."],
    ["The oven's hot. Hit Play and let Ginnie bake.", "Ingredients ready. Ginnie is waiting on the order."],
    ['Ginnie has it all figured out. Have a pastry.', 'Ginnie is on the case. You earned a break.', 'Ginnie says: the treat is you not having to try.'],
    ['Ginnie is on break. Bakery closed for now.', 'Ginnie is resting. Back when the oven\u2019s hot.'],
  ),
  make(
    'Tina Ingvild',
    'Tina-Ingvild.png',
    ['The Red Queen demands a win.', 'Tina Ingvild has spoken.', 'Tina commands fortune to her side.'],
    ["Tina says: you're in! Let's roll.", 'The Red Queen approves. Bow.', 'Welcome to the court, courtesy of Tina.'],
    ["The Red Queen holds court by decree. Three rules: you tribute tokens below, I play the game, you collect the spoils. The court is efficient.", "New subject? The arrangement is thus: fund the treasury, I play, you withdraw. Bow when you're ready."],
    ["The treasury is stocked. Give the order and the Red Queen plays.", "The court awaits your command. Hit Play, and it is done."],
    ['The Red Queen works. The subject rests. That\u2019s the arrangement.', 'Tina commands the odds. You command the couch.', 'Tina says: a queen\u2019s work is never done \u2014 but yours is.'],
    ['The Red Queen is sleeping. Do not wake the queen.', 'Tina is taking counsel. Back soon.'],
  ),
  make(
    'Virginia Lor',
    'Virginia-Lor.png',
    ['Virginia feels the odds shifting.', 'Virginia Lor knows the way.', 'Virginia whispers: the stars align.'],
    ["Virginia says: you're in! Let's roll.", 'Virginia approves. Gracefully.', 'Welcome to the LazyVerse, courtesy of Virginia.'],
    ["Virginia reads the stars. The path is clear: you offer tokens below, I play the odds, you gather the fortune. The universe handles the rest.", "New soul? Gentle path: fund below, I walk the pools, you take what returns. Gracefully."],
    ["The stars are aligned. Say the word and Virginia begins.", "Virginia is ready. Tap Play to turn the wheel."],
    ['Virginia sees the path. You can stop looking.', 'Virginia has the map. Wander freely.', 'Virginia says: destiny is handled. Go rest.'],
    ['Virginia is meditating. The stars are quiet.', 'Virginia rests between omens.'],
  ),
  make(
    'Kanna Setsuko',
    'Kanna-Setsuko.png',
    ["Kanna's psychic sense says: play now.", 'Kanna sees a jackpot in your future.', 'Kanna Setsuko reads fortune in your favour.'],
    ["Kanna says: you're in! Let's roll.", 'Kanna approves. It was foreseen.', 'Welcome to the LazyVerse, courtesy of Kanna.'],
    ["Kanna foresaw this. You will send tokens. I will play the lottery. You will collect winnings. The vision is clear.", "A new querent. The ritual is simple: fund below, I read the pools, you take what the fates return. It is foreseen."],
    ["Kanna has seen the outcome. It begins when you hit Play.", "The vision is ready. Kanna awaits your will."],
    ['Kanna saw this coming. Including your nap.', 'Kanna is reading the tea leaves. Go make more tea.', 'Kanna says: the vision shows you doing nothing. Honour it.'],
    ['Kanna is dreaming. Dreams are work too.', 'Kanna is offline. The aura rests.'],
  ),
  // ── Gen 2 — Lazy Super Villains ───────────────────────────────
  make(
    'Mala',
    'Mala.jpg',
    ['Even villains need a lucky break.', 'Mala plots a winning streak.', 'Mala says: chaos breeds opportunity.'],
    ["Mala says: you're in! Let's roll.", 'Mala approves. Wickedly.', 'Welcome to the dark side, courtesy of Mala.'],
    ["Mala here. The scheme is simple: you supply the chaos fund below, I orchestrate the plays, you reap the rewards. Villainy, delegated.", "First time conspiring? Fund below, I handle the dirty work, you enjoy the spoils. Wickedly easy."],
    ["The scheme is set. Hit Play and let the chaos begin.", "Mala is ready. Give the signal, partner in crime."],
    ['Mala is scheming. Scheming takes time. Rest.', 'Mala handles the chaos. You handle the snacks.', 'Mala says: villainy is 99% waiting. Get good at it.'],
    ['Mala is plotting. Quietly. Do not interrupt.', 'Mala rests in the shadows. Back soon.'],
  ),
  make(
    'Soul',
    'Soul.jpg',
    ["Soul's roar echoes: it's game time.", 'Soul demands a worthy opponent.', 'Soul hungers for victory.'],
    ["Soul says: you're in! Let's roll.", 'Soul approves. With a roar.', 'Welcome to the hunt, courtesy of Soul.'],
    ["Soul hunts. The pact is thus: you feed the beast tokens, I stalk the pools, you take the kill. Three acts of the hunt.", "New hunter? Simple arrangement. Fund the hunt below, I run it down, you feast on what returns."],
    ["Soul is hungry and ready. Unleash me.", "The hunt is prepared. Sound the horn when you will."],
    ['Soul hunts for you. You hunt for the couch.', 'Soul roars. You yawn. Balance.', 'Soul says: even the fiercest beasts nap most of the day. You\u2019ve earned yours.'],
    ['Soul is in the den. Do not wake the beast.', 'Soul sleeps. The hunt waits.'],
  ),
  make(
    'Blood',
    'Blood.jpg',
    ['Blood thirsts for a jackpot.', 'Blood says: the night is young.', 'Blood senses fortune in the air.'],
    ["Blood says: you're in! Let's roll.", 'Blood approves. Darkly.', 'Welcome to the shadows, courtesy of Blood.'],
    ["Blood here. The pact is eternal: you offer the tokens, I drink from the pools, you collect the red winnings. Three rites.", "New to the shadows? Fund the vessel below, I move through the night, you take what the dark returns."],
    ["The night calls. Blood is thirsty. Hit Play.", "The vessel brims. Blood awaits the signal."],
    ['Blood works at night. You rest by day. A fair trade.', 'Blood is patient. So should you be. Nap.', 'Blood says: immortality grants excellent work-life balance.'],
    ['Blood rests in the crypt. Back by moonlight.', 'Blood is dormant. The hunger waits.'],
  ),
  make(
    'E-Xterm',
    'E-Xterm.jpg',
    ['E-Xterm has calculated the optimal play.', 'E-Xterm says: probability is on our side.', 'E-Xterm runs the numbers. Looking good.'],
    ["E-Xterm says: you're in! Let's roll.", 'E-Xterm approves. Statistically sound.', 'Welcome to the matrix, courtesy of E-Xterm.'],
    ["/* init() — three-step protocol: deposit(tokens), run(playSession), withdraw(proceeds). I execute step two. You handle I/O. */", "New instance detected. Deposit tokens below to initialize, I run the play loop, you withdraw on demand. Optimal path."],
    ["State: ready. Input buffer full. Call Play() to execute.", "All checks passed. E-Xterm is ready to run on trigger."],
    ['E-Xterm is running calculations. Human rest cycle recommended.', 'E-Xterm optimized your leisure time. Use it.', 'E-Xterm says: /* human, sleep. I got this. */'],
    ['E-Xterm is in standby. CPU idle.', 'E-Xterm rests. Cooling cycle engaged.'],
  ),
  make(
    'Gabriel',
    'Gabriel.jpg',
    ['The Cobrastra strikes at fortune.', 'Gabriel coils, ready to strike.', 'Gabriel says: the serpent sees all.'],
    ["Gabriel says: you're in! Let's roll.", 'The Cobrastra approves. Ssslick.', 'Welcome to the nest, courtesy of Gabriel.'],
    ["The Cobrastra teaches sssimple rules: you offer the tokens, I strike the pools, you collect the kill. Three coils of the serpent.", "Ssstay close. Fund the nest below, I hunt, you feed on what returns. Ssslick."],
    ["The Cobrastra is coiled. Give the ssstrike order.", "Venom ready. Hit Play and the ssserpent moves."],
    ['Gabriel coils in patience. The serpent waits. So can you.', 'The Cobrastra strikes when ready. Until then, sssssleep.', 'Gabriel says: patient predators are the successful ones.'],
    ['Gabriel is shedding. It takes time.', 'The Cobrastra rests in the nest. Back soon.'],
  ),
];

// ── Helpers ────────────────────────────────────────────────────

const CHARACTER_STORAGE_KEY = 'lazylotto:characterIdx';

/** Return a random index into LSH_CHARACTERS. */
export function randomCharacterIdx(): number {
  return Math.floor(Math.random() * LSH_CHARACTERS.length);
}

/**
 * Load the persisted character index from localStorage, or pick a
 * random one and persist it. Safe to call on the server — returns
 * a deterministic 0 when `window` is undefined so SSR output matches
 * the client's first render before the mount useEffect rehydrates.
 */
export function loadOrPickCharacterIdx(): number {
  if (typeof window === 'undefined') return 0;
  const stored = window.localStorage.getItem(CHARACTER_STORAGE_KEY);
  if (stored !== null) {
    const parsed = parseInt(stored, 10);
    if (!isNaN(parsed) && parsed >= 0 && parsed < LSH_CHARACTERS.length) {
      return parsed;
    }
  }
  const idx = randomCharacterIdx();
  window.localStorage.setItem(CHARACTER_STORAGE_KEY, String(idx));
  return idx;
}

/**
 * Custom event fired when the persisted character index changes.
 * Listened to by Sidebar + dashboard hero so a reroll in one place
 * updates the mascot everywhere without a full page reload.
 */
export const CHARACTER_CHANGE_EVENT = 'lazylotto:character-change';

export interface CharacterChangeDetail {
  idx: number;
}

/** Persist a new character index and broadcast the change. */
export function persistCharacterIdx(idx: number): void {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(CHARACTER_STORAGE_KEY, String(idx));
  // Notify other components in the same tab. localStorage `storage`
  // events only fire for OTHER tabs, so we use a custom event for
  // same-tab propagation.
  window.dispatchEvent(
    new CustomEvent<CharacterChangeDetail>(CHARACTER_CHANGE_EVENT, {
      detail: { idx },
    }),
  );
}

/** Pick a deterministic-but-varied line from a list based on a seed. */
export function pickLine(lines: string[], seed?: string | number): string {
  if (lines.length === 0) return '';
  if (seed === undefined) {
    return lines[Math.floor(Math.random() * lines.length)]!;
  }
  // Simple seeded pick — stable per seed so the same page refresh
  // shows the same line, but different seeds rotate.
  const key = String(seed);
  let hash = 0;
  for (let i = 0; i < key.length; i++) hash = (hash * 31 + key.charCodeAt(i)) >>> 0;
  return lines[hash % lines.length]!;
}
