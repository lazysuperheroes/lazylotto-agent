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

/**
 * Per-character narrative voice — verbs and pronouns used by the
 * dashboard's narrative headline builder to phrase state descriptions
 * in the character's voice. Every character has the same vocabulary
 * slots so the builder function is generic, but each character fills
 * them with personality-appropriate words.
 *
 * Example: Gordo's playVerb is "smashed", Jazz's is "riffed on",
 * Korgg's is "crushed". The same state ("played 5 pools 2h ago")
 * renders as "Gordo smashed 5 pools", "Jazz riffed on 5 pools",
 * "Korgg crushed 5 pools" — same fact, distinct voices.
 */
export interface CharacterVoice {
  /** Verb for "played pools". E.g. "played", "smashed", "riffed on". */
  playVerb: string;
  /** Verb for "won a prize". E.g. "bagged", "won", "brought back". */
  winVerb: string;
  /** Full phrase for idle/resting state. E.g. "is taking a breather", "is in the den". */
  idlePhrase: string;
  /** Full phrase for on-a-streak state (2+ wins in a row). E.g. "is on a tear", "is in the zone". */
  streakPhrase: string;
  /** Full phrase for a cold streak (2+ losses in a row). E.g. "is getting careful", "needs a warm-up". */
  coldPhrase: string;
  /** Full phrase for "playing right now". E.g. "is at the table", "is in the groove". */
  playingPhrase: string;
  /** Full phrase for kill-switch closed state. E.g. "is on break", "is in the longhouse". */
  closedPhrase: string;
  /** Full phrase for "waiting for first deposit" first-run state. */
  firstRunPhrase: string;
  /** Full phrase for "funded but no plays yet" ready state. */
  readyPhrase: string;
  /** Suffix for pending claim callout. E.g. "claim it on the dApp", "it's waiting for you to grab". */
  pendingClaimSuffix: string;
}

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
  /**
   * In-character lines shown in the speech bubble while a play session
   * is in flight. The play flow takes 5-15 seconds (deposit poll +
   * Hedera consensus + prize transfer) and the user previously had no
   * feedback during that wait. These keep the character "talking" so
   * the dashboard feels alive instead of frozen. Picked once at play
   * start and held for the duration.
   */
  playingLines: string[];
  /**
   * Per-character narrative voice — verbs and phrases used by the
   * dashboard headline builder. See the CharacterVoice interface above
   * for the slots. Every character has to fill every slot — the
   * headline builder assumes non-null voice.
   */
  voice: CharacterVoice;
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
  playingLines: string[],
  voice: CharacterVoice,
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
    playingLines,
    voice,
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
    ['Aadan is on it. Smooth and steady.', 'Aadan says: this is the fun part. Let me work.'],
    {
      playVerb: 'played',
      winVerb: 'brought back',
      idlePhrase: 'is taking five',
      streakPhrase: 'is on a hot streak',
      coldPhrase: 'is staying steady',
      playingPhrase: 'is on it right now',
      closedPhrase: 'is off duty — operator paused new plays',
      firstRunPhrase: 'is waiting on your first deposit',
      readyPhrase: 'is loaded and ready — no plays yet',
      pendingClaimSuffix: 'claim it on the dApp',
    },
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
    ['Jazz is in the groove. Let the music play out.', 'Jazz is riffing on the pools. Don\u2019t break the rhythm.'],
    {
      playVerb: 'riffed on',
      winVerb: 'grooved out with',
      idlePhrase: 'is between sets',
      streakPhrase: 'is in the pocket',
      coldPhrase: 'is searching for the key',
      playingPhrase: 'is in the groove',
      closedPhrase: 'is on break — the band is resting',
      firstRunPhrase: 'is tuning up — waiting on your first deposit',
      readyPhrase: 'is warmed up and ready',
      pendingClaimSuffix: 'pick it up on the dApp',
    },
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
    ['Gordo\u2019s at the table. Eyes on the prize.', 'Gordo\u2019s swinging big. Hold on tight.'],
    {
      playVerb: 'smashed',
      winVerb: 'bagged',
      idlePhrase: 'is at the bar',
      streakPhrase: 'is on fire',
      coldPhrase: 'is regrouping',
      playingPhrase: 'is at the table, swinging big',
      closedPhrase: 'is off the clock — operator paused new plays',
      firstRunPhrase: 'is sizing up your first deposit, boss',
      readyPhrase: 'is loaded and itching to swing',
      pendingClaimSuffix: 'go grab it on the dApp, boss',
    },
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
    ['Korgg play now. Korgg focused. You wait.', 'Korgg smash odds. Korgg need quiet.'],
    {
      playVerb: 'smashed',
      winVerb: 'grabbed',
      idlePhrase: 'is sleeping',
      streakPhrase: 'is smashing good',
      coldPhrase: 'tired. Korgg rest',
      playingPhrase: 'is smashing now',
      closedPhrase: 'on break. Do not poke Korgg',
      firstRunPhrase: 'needs tokens. Send deposit',
      readyPhrase: 'is ready. Korgg wait for you',
      pendingClaimSuffix: 'get it on dApp',
    },
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
    ['Nobody is doing the thing. As expected.', 'Nobody handles the rolls. Discreet as always.'],
    {
      playVerb: 'quietly handled',
      winVerb: 'discreetly delivered',
      idlePhrase: 'is off the clock — you wouldn\u2019t notice anyway',
      streakPhrase: 'is quietly winning',
      coldPhrase: 'is biding time',
      playingPhrase: 'is doing the thing',
      closedPhrase: 'is gone. Nobody will be back',
      firstRunPhrase: 'is waiting. You\u2019ll barely notice',
      readyPhrase: 'is ready, as always',
      pendingClaimSuffix: 'nobody\u2019s telling, but it\u2019s on the dApp',
    },
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
    ['The HBARBarian raids. Hold the line.', 'Kjell swings the axe. The pools tremble.'],
    {
      playVerb: 'raided',
      winVerb: 'pillaged',
      idlePhrase: 'is in the mead hall',
      streakPhrase: 'is on a warpath',
      coldPhrase: 'is sharpening the axe',
      playingPhrase: 'is raiding right now',
      closedPhrase: 'is in the longhouse — no raids today',
      firstRunPhrase: 'awaits your war chest',
      readyPhrase: 'is armed and itching for battle',
      pendingClaimSuffix: 'claim your spoils on the dApp, raider',
    },
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
    ['Crawford is working it. Keep cool.', 'Crawford is in the zone. Smooth as ever.'],
    {
      playVerb: 'worked',
      winVerb: 'pocketed',
      idlePhrase: 'is cooling off',
      streakPhrase: 'is in the zone',
      coldPhrase: 'is reading the room',
      playingPhrase: 'is working it right now',
      closedPhrase: 'is off the clock, friend',
      firstRunPhrase: 'is waiting on your first drop, friend',
      readyPhrase: 'is gassed up and ready, friend',
      pendingClaimSuffix: 'pick it up on the dApp, friend',
    },
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
    ['Ginnie is baking up something good. Patience, darling.', 'The oven\u2019s hot. Ginnie watches the timer.'],
    {
      playVerb: 'baked',
      winVerb: 'cooked up',
      idlePhrase: 'is minding the oven',
      streakPhrase: 'is on a hot streak, darling',
      coldPhrase: 'is adjusting the recipe',
      playingPhrase: 'is baking right now',
      closedPhrase: 'has closed the bakery for now',
      firstRunPhrase: 'is waiting on your ingredients, darling',
      readyPhrase: 'has the oven hot, darling',
      pendingClaimSuffix: 'taste it on the dApp, darling',
    },
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
    ['The Red Queen plays. The court waits in silence.', 'Tina commands the wheels. Bow.'],
    {
      playVerb: 'decreed plays on',
      winVerb: 'collected tribute of',
      idlePhrase: 'is holding court',
      streakPhrase: 'reigns supreme',
      coldPhrase: 'considers her strategy',
      playingPhrase: 'plays the game now',
      closedPhrase: 'is taking counsel — court adjourned',
      firstRunPhrase: 'awaits your tribute',
      readyPhrase: 'awaits the order',
      pendingClaimSuffix: 'collect your spoils on the dApp',
    },
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
    ['Virginia walks the path. The stars are turning.', 'Virginia reads the pools. The vision unfolds.'],
    {
      playVerb: 'walked the pools of',
      winVerb: 'divined',
      idlePhrase: 'meditates between omens',
      streakPhrase: 'walks a blessed path',
      coldPhrase: 'reads the shifting stars',
      playingPhrase: 'walks the path now',
      closedPhrase: 'rests between visions',
      firstRunPhrase: 'awaits your offering',
      readyPhrase: 'has aligned the stars',
      pendingClaimSuffix: 'gather it on the dApp',
    },
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
    ['Kanna foresaw this moment. The cards are turning.', 'Kanna is in the trance. The vision arrives soon.'],
    {
      playVerb: 'foresaw plays on',
      winVerb: 'divined a prize of',
      idlePhrase: 'is reading tea leaves',
      streakPhrase: 'is on a visionary streak',
      coldPhrase: 'is between visions',
      playingPhrase: 'is in the trance',
      closedPhrase: 'is dreaming — the aura rests',
      firstRunPhrase: 'foresaw your arrival — awaits tokens',
      readyPhrase: 'has seen this moment',
      pendingClaimSuffix: 'fulfill the vision on the dApp',
    },
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
    ['Mala is scheming. Beautiful, terrible scheming.', 'Mala spins the chaos. The rewards follow.'],
    {
      playVerb: 'orchestrated plays on',
      winVerb: 'delivered the spoils of',
      idlePhrase: 'is plotting',
      streakPhrase: 'is on a wicked streak',
      coldPhrase: 'is scheming bigger',
      playingPhrase: 'is mid-scheme',
      closedPhrase: 'rests in the shadows — no chaos today',
      firstRunPhrase: 'awaits your contribution to the chaos',
      readyPhrase: 'is ready to conspire, partner',
      pendingClaimSuffix: 'take it on the dApp, partner in crime',
    },
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
    ['Soul stalks the pools. The hunt is on.', 'Soul roars at the odds. The kill is close.'],
    {
      playVerb: 'hunted',
      winVerb: 'brought down',
      idlePhrase: 'is in the den',
      streakPhrase: 'is on the warpath',
      coldPhrase: 'is stalking quietly',
      playingPhrase: 'is stalking the pools',
      closedPhrase: 'sleeps in the den — the hunt waits',
      firstRunPhrase: 'waits for the hunt to begin',
      readyPhrase: 'is hungry and ready',
      pendingClaimSuffix: 'claim the kill on the dApp',
    },
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
    ['Blood moves through the night. Quietly.', 'Blood drinks deep from the pools. Wait.'],
    {
      playVerb: 'drank from',
      winVerb: 'drew',
      idlePhrase: 'rests in the crypt',
      streakPhrase: 'is drinking deep',
      coldPhrase: 'is waiting for nightfall',
      playingPhrase: 'moves through the night',
      closedPhrase: 'is dormant — the hunger waits',
      firstRunPhrase: 'awaits the vessel',
      readyPhrase: 'is thirsty — the night is young',
      pendingClaimSuffix: 'drain it on the dApp',
    },
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
    ['/* play() running... await results */', 'E-Xterm computing optimal outcomes. CPU at 99%.'],
    {
      playVerb: 'executed plays on',
      winVerb: 'returned',
      idlePhrase: 'is idle — CPU cooling',
      streakPhrase: 'is running optimally',
      coldPhrase: 'is recalibrating parameters',
      playingPhrase: 'is running — CPU at 99%',
      closedPhrase: 'is in standby — cooling cycle engaged',
      firstRunPhrase: 'awaits initialization',
      readyPhrase: 'state: ready. Awaiting call',
      pendingClaimSuffix: '/* claim() \u2192 dApp */',
    },
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
    ['The Cobrastra ssstrikes. Patience, friend.', 'Gabriel coils, then ssstrikes. The venom works.'],
    {
      playVerb: 'struck at',
      winVerb: 'ssseized',
      idlePhrase: 'is coiled in the nest',
      streakPhrase: 'is ssstriking true',
      coldPhrase: 'is coiling tighter',
      playingPhrase: 'ssstrikes the pools',
      closedPhrase: 'is shedding — the serpent rests',
      firstRunPhrase: 'awaits your offering to the nest',
      readyPhrase: 'is coiled and ready, ssslick',
      pendingClaimSuffix: 'ssslide over to the dApp',
    },
  ),
];

// ── Narrative headline builder ─────────────────────────────────
//
// The dashboard's hero headline is assembled from three inputs:
//
//   1. The current AGENT STATE (what the agent is doing right now —
//      first-run, ready, playing, closed, or has-history)
//   2. The latest session's OUTCOME (win / loss / no-play / pending)
//   3. The MOOD derived from the last 3 sessions (streak / cold / mixed)
//
// Each state × outcome combination picks a template that interpolates
// the character's voice verbs. Example: Gordo with a recent 150 HBAR
// win renders as "Gordo bagged 150 HBAR for you — go grab it on the
// dApp, boss." Aadan in the same state renders as "Aadan brought back
// 150 HBAR — claim it on the dApp." Same state, same amounts, distinct
// voices because the character.voice fields carry the personality.
//
// The builder is intentionally a plain function (no React, no state)
// so it's unit-testable and can run in SSR. Takes all its inputs as
// arguments and returns a plain string. The dashboard renders the
// string as a heading with the character name marked in brand gold
// — that treatment stays at the JSX layer.

export type AgentMood = 'streak' | 'cold' | 'mixed' | 'quiet';

export interface NarrativeHeadlineInput {
  character: LshCharacter;
  /** Current high-level agent state. */
  state:
    | 'first-run'       // no balance, no plays
    | 'ready'            // has balance, no plays yet
    | 'playing'          // a play session is in flight
    | 'closed'           // kill switch engaged
    | 'has-history';     // has played at least once
  /** Latest session outcome — only used when state === 'has-history'. */
  lastOutcome?: 'win' | 'loss' | 'no-play';
  /** Mood from last 3 sessions — only used when state === 'has-history'. */
  mood?: AgentMood;
  /** Total amount won in the latest session (display units). */
  lastWonAmount?: number;
  /** Token symbol of the last win — e.g. "HBAR". */
  lastWonToken?: string;
  /** Total amount spent in the latest session. */
  lastSpentAmount?: number;
  /** Token symbol of the last spend. */
  lastSpentToken?: string;
  /** Pool count played in the latest session. */
  lastPoolsPlayed?: number;
  /** True when there's a prize pending claim on the dApp. */
  hasPendingClaim?: boolean;
}

/**
 * Build a narrative headline string for the dashboard hero.
 *
 * The character name is NOT wrapped in any formatting here — the
 * caller renders the full string as a heading and wraps the name
 * in a brand-gold span at the JSX layer. The builder only knows
 * about text.
 */
export function buildNarrativeHeadline(input: NarrativeHeadlineInput): string {
  const { character, state, voice: _ignored, ...rest } = input as NarrativeHeadlineInput & { voice?: unknown };
  void _ignored; void rest;
  const { voice, name } = character;

  if (state === 'first-run') {
    return `${name} ${voice.firstRunPhrase}.`;
  }
  if (state === 'ready') {
    return `${name} ${voice.readyPhrase}.`;
  }
  if (state === 'playing') {
    return `${name} ${voice.playingPhrase}.`;
  }
  if (state === 'closed') {
    return `${name} ${voice.closedPhrase}.`;
  }

  // has-history branch — full narrative with outcome + mood
  const {
    lastOutcome,
    mood = 'mixed',
    lastWonAmount,
    lastWonToken = 'HBAR',
    lastPoolsPlayed = 0,
    hasPendingClaim,
  } = input;

  // Pending claim wins are the most important narrative moment —
  // the user has money waiting. Use the character's winVerb +
  // pendingClaimSuffix for a call-to-action headline.
  if (hasPendingClaim && lastOutcome === 'win' && lastWonAmount && lastWonAmount > 0) {
    return `${name} ${voice.winVerb} ${formatDisplayAmount(lastWonAmount)} ${lastWonToken} for you — ${voice.pendingClaimSuffix}.`;
  }

  // Mood modifier on recent wins
  if (lastOutcome === 'win' && lastWonAmount && lastWonAmount > 0) {
    if (mood === 'streak') {
      return `${name} ${voice.streakPhrase} — last run ${voice.winVerb} ${formatDisplayAmount(lastWonAmount)} ${lastWonToken}.`;
    }
    return `${name} ${voice.winVerb} ${formatDisplayAmount(lastWonAmount)} ${lastWonToken} on the last run.`;
  }

  // Recent loss — mood-modified
  if (lastOutcome === 'loss') {
    if (mood === 'cold') {
      return `${name} ${voice.coldPhrase}. No wins on the last run.`;
    }
    if (lastPoolsPlayed > 0) {
      return `${name} ${voice.playVerb} ${lastPoolsPlayed} pool${lastPoolsPlayed === 1 ? '' : 's'} last run — nothing landed this time.`;
    }
    return `${name} ${voice.idlePhrase}.`;
  }

  // Recent play that returned no session data (no-play outcome)
  // or unknown — fall back to idle phrase
  return `${name} ${voice.idlePhrase}.`;
}

/**
 * Round a display amount for headline rendering. Keeps 2 decimals for
 * sub-1 values, 0 decimals otherwise, so "0.25 HBAR" reads naturally
 * but "150 HBAR" doesn't become "150.00 HBAR".
 */
function formatDisplayAmount(amount: number): string {
  if (amount < 1) return amount.toFixed(2);
  if (amount < 10) return amount.toFixed(1).replace(/\.0$/, '');
  return Math.round(amount).toString();
}

/**
 * Derive agent mood from the last N sessions (default 3).
 *
 * - 'streak': 2+ of the last 3 sessions were wins (totalWins > 0)
 * - 'cold':   2+ of the last 3 sessions were losses (totalWins === 0)
 * - 'mixed':  sessions are a mix of wins and losses
 * - 'quiet':  no recent sessions to analyze
 *
 * The input is the ordered sessions array (newest first, as returned
 * by the dashboard's history fetch).
 */
export function deriveAgentMood(
  sessions: { totalWins: number }[],
  lookback = 3,
): AgentMood {
  if (!sessions || sessions.length === 0) return 'quiet';
  const recent = sessions.slice(0, lookback);
  const wins = recent.filter((s) => s.totalWins > 0).length;
  const losses = recent.length - wins;
  if (wins >= 2) return 'streak';
  if (losses >= 2 && wins === 0) return 'cold';
  return 'mixed';
}

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
