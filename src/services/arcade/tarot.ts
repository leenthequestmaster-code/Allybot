import {
  type BaseGameAction,
  type GameActionResult,
  type GameEngine,
  type GamePlayer,
  cloneState,
  formatPlayerTag,
  nextInt,
  nextRandom,
  resolveInitialSeed,
  shuffleWithSeed,
} from './types.js';

// ============================================================================
// 2. TAROT ENGINE (DECK 78 KARTU MAJOR & MINOR ARCANA, 1 ATAU 3 KARTU)
// ============================================================================

export type TarotArcanaType = 'major' | 'minor';
export type TarotSuit = 'Major' | 'Wands' | 'Cups' | 'Swords' | 'Pentacles';
export type TarotSpreadType = 'single' | 'three';
export type TarotOrientation = 'tegak' | 'terbalik';

export interface TarotCardSpec {
  readonly id: number; // 0..77
  readonly code: string;
  readonly nameId: string;
  readonly nameEn: string;
  readonly arcana: TarotArcanaType;
  readonly suit: TarotSuit;
  readonly keywords: readonly string[];
  readonly maknaTegak: string;
  readonly maknaTerbalik: string;
}

export interface DrawnTarotCard {
  readonly positionIndex: number;
  readonly positionLabel: 'Fokus Utama' | 'Masa Lalu' | 'Sekarang' | 'Masa Depan';
  readonly card: TarotCardSpec;
  readonly orientation: TarotOrientation;
  readonly activeMeaning: string;
}

export interface TarotState {
  readonly gameId: string;
  readonly groupJid: string;
  readonly gameType: 'tarot';
  status: 'ready' | 'completed';
  seed: number;
  host: GamePlayer;
  spreadType: TarotSpreadType;
  question?: string;
  drawnCards: DrawnTarotCard[];
  createdAt: number;
}

export interface TarotAction extends BaseGameAction {
  readonly type: 'DRAW' | 'TARIK' | 'READ';
  readonly payload?: {
    readonly spreadType?: TarotSpreadType;
    readonly count?: 1 | 3;
    readonly question?: string;
  };
}

const MAJOR_ARCANA_22: readonly Omit<TarotCardSpec, 'id' | 'arcana' | 'suit'>[] = [
  {
    code: 'MAJ-00',
    nameId: '0 - Sang Pengembara (The Fool)',
    nameEn: 'The Fool',
    keywords: ['Awal Baru', 'Spontanitas', 'Keberanian'],
    maknaTegak: 'Langkah awal yang segar, kepolosan, dan keberanian membuka lembaran baru dengan pikiran terbuka.',
    maknaTerbalik: 'Kecerobohan, keraguan melangkah, atau mengambil risiko tanpa perhitungan matang.',
  },
  {
    code: 'MAJ-01',
    nameId: 'I - Sang Penyihir (The Magician)',
    nameEn: 'The Magician',
    keywords: ['Manifestasi', 'Keahlian', 'Daya Cipta'],
    maknaTegak: 'Seluruh sumber daya sudah ada di tanganmu untuk mewujudkan rencana menjadi kenyataan.',
    maknaTerbalik: 'Bakat yang belum terarah, manipulasi, atau keraguan terhadap kemampuan diri sendiri.',
  },
  {
    code: 'MAJ-02',
    nameId: 'II - Sang Pendeta Agung (The High Priestess)',
    nameEn: 'The High Priestess',
    keywords: ['Intuisi', 'Misteri', 'Kebijaksanaan Batin'],
    maknaTegak: 'Dengarkan suara hati dan intuisi terdalam; jawaban yang dicari ada di balik permukaan.',
    maknaTerbalik: 'Mengabaikan firasat batin, rahasia yang terpendam, atau kebingungan emosional.',
  },
  {
    code: 'MAJ-03',
    nameId: 'III - Sang Permaisuri (The Empress)',
    nameEn: 'The Empress',
    keywords: ['Kelimpahan', 'Kasih Sayang', 'Kreativitas'],
    maknaTegak: 'Pertumbuhan subur, harmoni keluarga, dan mengalirnya ide-ide kreatif yang membawa berkah.',
    maknaTerbalik: 'Kelelahan mengurus orang lain, hambatan kreatif, atau ketergantungan berlebih.',
  },
  {
    code: 'MAJ-04',
    nameId: 'IV - Sang Kaisar (The Emperor)',
    nameEn: 'The Emperor',
    keywords: ['Otoritas', 'Struktur', 'Stabilitas'],
    maknaTegak: 'Kepemimpinan tegas, disiplin tinggi, dan fondasi yang kokoh untuk jangka panjang.',
    maknaTerbalik: 'Sikap terlalu kaku, dominasi berlebihan, atau hilangnya kendali atas aturan.',
  },
  {
    code: 'MAJ-05',
    nameId: 'V - Sang Hierofan (The Hierophant)',
    nameEn: 'The Hierophant',
    keywords: ['Tradisi', 'Mentor', 'Etika'],
    maknaTegak: 'Belajar dari mentor atau nilai luhur yang teruji waktu memberikan arah yang pasti.',
    maknaTerbalik: 'Menantang konvensi lama yang mengekang dan mencari jalan spiritual/prinsip mandiri.',
  },
  {
    code: 'MAJ-06',
    nameId: 'VI - Sepasang Kekasih (The Lovers)',
    nameEn: 'The Lovers',
    keywords: ['Komitmen', 'Keselarasan', 'Pilihan Hati'],
    maknaTegak: 'Ikatan yang tulus, keselarasan nilai, atau keputusan penting yang diambil sepenuh hati.',
    maknaTerbalik: 'Dilema batin, ketidakharmonisan komunikasi, atau ragu memegang komitmen.',
  },
  {
    code: 'MAJ-07',
    nameId: 'VII - Kereta Perang (The Chariot)',
    nameEn: 'The Chariot',
    keywords: ['Determinasi', 'Kemenangan', 'Fokus'],
    maknaTegak: 'Kemenangan melalui tekad baja dan pengendalian diri yang terarah penuh.',
    maknaTerbalik: 'Kehilangan arah tujuan, agresivitas tanpa rem, atau hambatan perjalanan.',
  },
  {
    code: 'MAJ-08',
    nameId: 'VIII - Kekuatan (Strength)',
    nameEn: 'Strength',
    keywords: ['Ketabahan', 'Kesabaran', 'Kelembutan'],
    maknaTegak: 'Kekuatan sejati lahir dari kesabaran, ketenangan batin, dan penguasaan emosi.',
    maknaTerbalik: 'Kelelahan mental, keraguan diri, atau bereaksi impulsif karena takut.',
  },
  {
    code: 'MAJ-09',
    nameId: 'IX - Sang Pertapa (The Hermit)',
    nameEn: 'The Hermit',
    keywords: ['Kontemplasi', 'Pencarian Jati Diri', 'Pencerahan'],
    maknaTegak: 'Saatnya menarik diri sejenak dari keramaian untuk merenung dan menemukan kebijaksanaan.',
    maknaTerbalik: 'Mengisolasi diri terlalu jauh, kesepian, atau menolak nasihat bijak.',
  },
  {
    code: 'MAJ-10',
    nameId: 'X - Roda Keberuntungan (Wheel of Fortune)',
    nameEn: 'Wheel of Fortune',
    keywords: ['Siklus Hidup', 'Takdir', 'Momentum'],
    maknaTegak: 'Perubahan nasib ke arah positif; manfaatkan peluang emas yang sedang berputar.',
    maknaTerbalik: 'Fase ujian sementara; tetap tenang menghadapi perubahan di luar kendali.',
  },
  {
    code: 'MAJ-11',
    nameId: 'XI - Keadilan (Justice)',
    nameEn: 'Justice',
    keywords: ['Kebenaran', 'Hukum Sebab-Akibat', 'Objektivitas'],
    maknaTegak: 'Keputusan yang adil dan seimbang; setiap tindakan jujur akan membuahkan hasil setimpal.',
    maknaTerbalik: 'Ketidakseimbangan penilaian, berat sebelah, atau menghindari tanggung jawab.',
  },
  {
    code: 'MAJ-12',
    nameId: 'XII - Sang Tergantung (The Hanged Man)',
    nameEn: 'The Hanged Man',
    keywords: ['Sudut Pandang Baru', 'Pengorbanan', 'Jeda'],
    maknaTegak: 'Berhenti memaksakan keadaan; melihat masalah dari sudut pandang terbalik membuka solusi.',
    maknaTerbalik: 'Penundaan sia-sia, keras kepala menolak berubah, atau pengorbanan yang tidak perlu.',
  },
  {
    code: 'MAJ-13',
    nameId: 'XIII - Transformasi (Death)',
    nameEn: 'Death',
    keywords: ['Akhir Siklus', 'Kelahiran Kembali', 'Transisi'],
    maknaTegak: 'Berakhirnya fase lama demi memberi ruang bagi pertumbuhan baru yang lebih sehat.',
    maknaTerbalik: 'Takut melepaskan masa lalu atau menahan perubahan yang seharusnya sudah terjadi.',
  },
  {
    code: 'MAJ-14',
    nameId: 'XIV - Kesederhanaan (Temperance)',
    nameEn: 'Temperance',
    keywords: ['Keseimbangan', 'Moderasi', 'Harmoni'],
    maknaTegak: 'Memadukan dua hal berbeda secara harmonis dengan kesabaran dan jalan tengah.',
    maknaTerbalik: 'Sikap ekstrem, terburu-buru, atau hilangnya keseimbangan antara kerja dan istirahat.',
  },
  {
    code: 'MAJ-15',
    nameId: 'XV - Belenggu Bayangan (The Devil)',
    nameEn: 'The Devil',
    keywords: ['Keterikatan', 'Ambisi Material', 'Godaan'],
    maknaTegak: 'Waspadai kebiasaan buruk atau keterikatan berlebihan yang membatasi kebebasanmu.',
    maknaTerbalik: 'Melepaskan diri dari belenggu lama dan mendapatkan kembali kemerdekaan batin.',
  },
  {
    code: 'MAJ-16',
    nameId: 'XVI - Menara Runtuh (The Tower)',
    nameEn: 'The Tower',
    keywords: ['Perubahan Mendadak', 'Kebenaran Terungkap', 'Pembersihan'],
    maknaTegak: 'Runtuhnya asumsi palsu secara mengejutkan agar kamu bisa membangun ulang di atas fondasi jujur.',
    maknaTerbalik: 'Menunda guncangan yang tak terhindarkan atau berhasil meminimalkan dampak krisis.',
  },
  {
    code: 'MAJ-17',
    nameId: 'XVII - Sang Bintang (The Star)',
    nameEn: 'The Star',
    keywords: ['Harapan', 'Inspirasi', 'Pemulihan'],
    maknaTegak: 'Cahaya harapan kembali bersinar setelah badai; masa penyembuhan dan optimisme murni.',
    maknaTerbalik: 'Pesimisme sesaat, meragukan impian sendiri, atau kehilangan semangat.',
  },
  {
    code: 'MAJ-18',
    nameId: 'XVIII - Sang Rembulan (The Moon)',
    nameEn: 'The Moon',
    keywords: ['Ilusi', 'Alam Bawah Sadar', 'Keraguan'],
    maknaTegak: 'Situasi belum sepenuhnya terlihat jelas; jangan terburu-buru percaya pada asumsi semata.',
    maknaTerbalik: 'Kabut kebingungan mulai tersibak dan kebenaran yang sempat samar mulai tampak.',
  },
  {
    code: 'MAJ-19',
    nameId: 'XIX - Sang Mentari (The Sun)',
    nameEn: 'The Sun',
    keywords: ['Kegembiraan', 'Kesuksesan', 'Kejelasan'],
    maknaTegak: 'Keberhasilan gemilang, kehangatan, dan kejelasan penuh dalam langkah yang kamu tempuh.',
    maknaTerbalik: 'Keberhasilan yang sedikit tertunda atau ekspektasi yang terlalu tinggi.',
  },
  {
    code: 'MAJ-20',
    nameId: 'XX - Kebangkitan (Judgement)',
    nameEn: 'Judgement',
    keywords: ['Panggilan Jiwa', 'Evaluasi Diri', 'Keputusan Besar'],
    maknaTegak: 'Momen kebangkitan dan evaluasi matang untuk melangkah ke level kehidupan berikutnya.',
    maknaTerbalik: 'Terlalu keras menghakimi diri sendiri atau ragu mengambil keputusan penting.',
  },
  {
    code: 'MAJ-21',
    nameId: 'XXI - Semesta (The World)',
    nameEn: 'The World',
    keywords: ['Penyelesaian', 'Keutuhan', 'Pencapaian'],
    maknaTegak: 'Satu siklus besar tuntas dengan manis; pencapaian utuh dan kesiapan menyambut horizon baru.',
    maknaTerbalik: 'Proyek yang hampir selesai namun masih menyisakan satu detail akhir yang perlu dibereskan.',
  },
];

const MINOR_SUITS: readonly {
  suit: 'Wands' | 'Cups' | 'Swords' | 'Pentacles';
  labelId: string;
  themeTegak: string;
  themeTerbalik: string;
}[] = [
  {
    suit: 'Wands',
    labelId: 'Tongkat',
    themeTegak: 'semangat aksi, inisiatif kreatif, dan dorongan karier',
    themeTerbalik: 'hambatan momentum, kejenuhan energi, atau tergesa-gesa',
  },
  {
    suit: 'Cups',
    labelId: 'Cawan',
    themeTegak: 'kedalaman emosi, empati hubungan, dan ketenangan batin',
    themeTerbalik: 'emosi yang terpendam, ekspektasi perasaan, atau kepekaan berlebih',
  },
  {
    suit: 'Swords',
    labelId: 'Pedang',
    themeTegak: 'ketajaman logika, kejujuran komunikasi, dan ketegasan pikiran',
    themeTerbalik: 'overthinking, perdebatan tajam, atau keraguan mengambil keputusan',
  },
  {
    suit: 'Pentacles',
    labelId: 'Koin',
    themeTegak: 'kestabilan finansial, hasil kerja nyata, dan ketekunan praktis',
    themeTerbalik: 'ketidakseimbangan anggaran, penundaan hasil materi, atau kurang fokus praktis',
  },
];

const MINOR_RANKS: readonly {
  rankCode: string;
  nameId: string;
  nameEn: string;
  keyword: string;
  uprightPrefix: string;
  reversedPrefix: string;
}[] = [
  {
    rankCode: '01',
    nameId: 'As',
    nameEn: 'Ace',
    keyword: 'Benih Baru',
    uprightPrefix: 'Peluang perdana yang sangat kuat dalam',
    reversedPrefix: 'Awal yang tertunda atau ragu memulai dalam',
  },
  {
    rankCode: '02',
    nameId: 'Dua',
    nameEn: 'Two',
    keyword: 'Kemitraan & Pilihan',
    uprightPrefix: 'Penyeimbangan langkah dan perencanaan dua arah dalam',
    reversedPrefix: 'Kebimbangan memilih arah dalam',
  },
  {
    rankCode: '03',
    nameId: 'Tiga',
    nameEn: 'Three',
    keyword: 'Kolaborasi & Ekspansi',
    uprightPrefix: 'Kemajuan awal melalui kerja sama dan perluasan cakrawala dalam',
    reversedPrefix: 'Kurangnya koordinasi tim dalam',
  },
  {
    rankCode: '04',
    nameId: 'Empat',
    nameEn: 'Four',
    keyword: 'Kestabilan & Fondasi',
    uprightPrefix: 'Konsolidasi aman dan rasa syukur atas fondasi dalam',
    reversedPrefix: 'Zona nyaman yang terlalu pasif dalam',
  },
  {
    rankCode: '05',
    nameId: 'Lima',
    nameEn: 'Five',
    keyword: 'Tantangan & Adaptasi',
    uprightPrefix: 'Ujian dinamika yang menempa ketangguhan mental dalam',
    reversedPrefix: 'Meredanya gesekan dan pemulihan setelah ujian dalam',
  },
  {
    rankCode: '06',
    nameId: 'Enam',
    nameEn: 'Six',
    keyword: 'Harmoni & Kemajuan',
    uprightPrefix: 'Aliran dukungan timbal balik dan pengakuan positif dalam',
    reversedPrefix: 'Ketidakseimbangan memberi dan menerima dalam',
  },
  {
    rankCode: '07',
    nameId: 'Tujuh',
    nameEn: 'Seven',
    keyword: 'Ketekunan & Evaluasi',
    uprightPrefix: 'Mempertahankan prinsip dan mengevaluasi strategi jangka panjang dalam',
    reversedPrefix: 'Kewalahan menghadapi banyak opsi sekaligus dalam',
  },
  {
    rankCode: '08',
    nameId: 'Delapan',
    nameEn: 'Eight',
    keyword: 'Penguasaan & Akselerasi',
    uprightPrefix: 'Fokus tinggi dan percepatan keterampilan menuju hasil nyata dalam',
    reversedPrefix: 'Rutinitas yang terasa monoton atau terburu-buru dalam',
  },
  {
    rankCode: '09',
    nameId: 'Sembilan',
    nameEn: 'Nine',
    keyword: 'Ketahanan & Pematangan',
    uprightPrefix: 'Kemandirian matang dan ketabahan menjelang garis akhir dalam',
    reversedPrefix: 'Sikap terlalu defensif atau kelelahan menjelang akhir dalam',
  },
  {
    rankCode: '10',
    nameId: 'Sepuluh',
    nameEn: 'Ten',
    keyword: 'Puncak Siklus',
    uprightPrefix: 'Penyelesaian penuh dan warisan hasil maksimal dalam',
    reversedPrefix: 'Memikul beban tanggung jawab berlebih sendirian dalam',
  },
  {
    rankCode: '11',
    nameId: 'Pelayan (Page)',
    nameEn: 'Page',
    keyword: 'Kabar & Rasa Ingin Tahu',
    uprightPrefix: 'Pesan segar, antusiasme belajar, dan ide muda dalam',
    reversedPrefix: 'Kabar yang belum matang atau kurang fokus belajar dalam',
  },
  {
    rankCode: '12',
    nameId: 'Ksatria (Knight)',
    nameEn: 'Knight',
    keyword: 'Gerak Cepat & Misi',
    uprightPrefix: 'Tindakan berani dan pergerakan progresif mengejar target dalam',
    reversedPrefix: 'Langkah yang kurang sabar atau berubah-ubah arah dalam',
  },
  {
    rankCode: '13',
    nameId: 'Ratu (Queen)',
    nameEn: 'Queen',
    keyword: 'Kematangan Batin & Asuhan',
    uprightPrefix: 'Kebijaksanaan hangat, kepekaan dewasa, dan kemandirian dalam',
    reversedPrefix: 'Kelelahan mengayomi atau suasana hati yang goyah dalam',
  },
  {
    rankCode: '14',
    nameId: 'Raja (King)',
    nameEn: 'King',
    keyword: 'Kepemimpinan & Visi',
    uprightPrefix: 'Otoritas matang, penguasaan penuh, dan keputusan strategis dalam',
    reversedPrefix: 'Sikap terlalu mengontrol atau kurang fleksibel dalam',
  },
];

export const TAROT_DECK_78: readonly TarotCardSpec[] = (() => {
  const deck: TarotCardSpec[] = [];
  for (let i = 0; i < MAJOR_ARCANA_22.length; i++) {
    const m = MAJOR_ARCANA_22[i];
    deck.push({
      id: i,
      code: m.code,
      nameId: m.nameId,
      nameEn: m.nameEn,
      arcana: 'major',
      suit: 'Major',
      keywords: m.keywords,
      maknaTegak: m.maknaTegak,
      maknaTerbalik: m.maknaTerbalik,
    });
  }
  let nextId = 22;
  for (const s of MINOR_SUITS) {
    for (const r of MINOR_RANKS) {
      deck.push({
        id: nextId++,
        code: `${s.suit.slice(0, 3).toUpperCase()}-${r.rankCode}`,
        nameId: `${r.nameId} ${s.labelId}`,
        nameEn: `${r.nameEn} of ${s.suit}`,
        arcana: 'minor',
        suit: s.suit,
        keywords: [r.keyword, s.labelId],
        maknaTegak: `${r.uprightPrefix} ${s.themeTegak}.`,
        maknaTerbalik: `${r.reversedPrefix} ${s.themeTerbalik}.`,
      });
    }
  }
  return deck;
})();

export function drawTarotSpread(
  seed: number,
  spreadType: TarotSpreadType,
): { drawn: DrawnTarotCard[]; nextSeed: number } {
  const count = spreadType === 'three' ? 3 : 1;
  const labels: readonly ('Fokus Utama' | 'Masa Lalu' | 'Sekarang' | 'Masa Depan')[] =
    spreadType === 'three'
      ? ['Masa Lalu', 'Sekarang', 'Masa Depan']
      : ['Fokus Utama'];

  const shuffled = shuffleWithSeed(TAROT_DECK_78, seed);
  let curSeed = shuffled.nextSeed;
  const drawn: DrawnTarotCard[] = [];

  for (let i = 0; i < count; i++) {
    const card = shuffled.items[i];
    const orientStep = nextRandom(curSeed);
    curSeed = orientStep.nextSeed;
    const orientation: TarotOrientation = orientStep.value < 0.65 ? 'tegak' : 'terbalik';
    drawn.push({
      positionIndex: i,
      positionLabel: labels[i],
      card,
      orientation,
      activeMeaning: orientation === 'tegak' ? card.maknaTegak : card.maknaTerbalik,
    });
  }

  return { drawn, nextSeed: curSeed };
}

export function formatTarotReadingMessage(state: TarotState): string {
  const header = state.spreadType === 'three'
    ? '🔮 *TEBARAN TAROT 3 KARTU (MASA LALU • SEKARANG • MASA DEPAN)*'
    : '🔮 *TARIKAN KARTU TAROT UTAMA (1 KARTU)*';

  const lines: string[] = [
    header,
    `Penanya: ${formatPlayerTag(state.host.jid)} (${state.host.name})`,
  ];
  if (state.question) {
    lines.push(`Pertanyaan: _"${state.question}"_`);
  }
  lines.push('');

  for (const item of state.drawnCards) {
    const orientBadge = item.orientation === 'tegak' ? '⬆️ Tegak (Upright)' : '⬇️ Terbalik (Reversed)';
    lines.push(
      `*[${item.positionLabel}]* — *${item.card.nameId}* (${orientBadge})`,
      `• Kata Kunci: ${item.card.keywords.join(', ')}`,
      `• Tafsir: ${item.activeMeaning}`,
      '',
    );
  }

  return lines.join('\n').trim();
}

export class TarotEngine implements GameEngine<TarotState, TarotAction> {
  readonly gameType = 'tarot';
  readonly displayName = 'Tarot Arcana (78 Kartu Major & Minor)';
  readonly category = 'instant' as const;
  readonly minPlayers = 1;
  readonly maxPlayers = 10;
  readonly defaultTurnTimeoutMs = 60_000;

  createInitialState(options: {
    gameId: string;
    groupJid: string;
    host: GamePlayer;
    wagerAmount?: number;
    customConfig?: Record<string, unknown>;
  }): TarotState {
    const initialSeed = resolveInitialSeed(options.customConfig, options.gameId);
    const rawCount = options.customConfig?.count ?? options.customConfig?.spreadType;
    const spreadType: TarotSpreadType =
      rawCount === 3 || rawCount === 'three' || rawCount === '3' ? 'three' : 'single';
    const question = typeof options.customConfig?.question === 'string'
      ? options.customConfig.question.trim()
      : undefined;
    const autoDraw = Boolean(options.customConfig?.autoDraw ?? false);

    if (autoDraw) {
      const res = drawTarotSpread(initialSeed, spreadType);
      return {
        gameId: options.gameId,
        groupJid: options.groupJid,
        gameType: 'tarot',
        status: 'completed',
        seed: res.nextSeed,
        host: options.host,
        spreadType,
        question,
        drawnCards: res.drawn,
        createdAt: Date.now(),
      };
    }

    return {
      gameId: options.gameId,
      groupJid: options.groupJid,
      gameType: 'tarot',
      status: 'ready',
      seed: initialSeed,
      host: options.host,
      spreadType,
      question,
      drawnCards: [],
      createdAt: Date.now(),
    };
  }

  processAction(state: TarotState, action: TarotAction): GameActionResult<TarotState> {
    const next = cloneState(state);
    if (action.type !== 'DRAW' && action.type !== 'TARIK' && action.type !== 'READ') {
      return {
        success: false,
        error: `Aksi Tarot tidak dikenal: ${String(action.type)}`,
        state: next,
      };
    }

    const reqSpread: TarotSpreadType =
      action.payload?.count === 3 || action.payload?.spreadType === 'three'
        ? 'three'
        : action.payload?.count === 1 || action.payload?.spreadType === 'single'
          ? 'single'
          : next.spreadType;

    if (action.payload?.question) {
      next.question = action.payload.question.trim();
    }

    next.spreadType = reqSpread;
    const drawRes = drawTarotSpread(next.seed, reqSpread);
    next.seed = drawRes.nextSeed;
    next.drawnCards = drawRes.drawn;
    next.status = 'completed';

    return {
      success: true,
      state: next,
      isGameOver: true,
      winnerJids: [action.playerJid],
      mentions: [action.playerJid],
      broadcastMessage: formatTarotReadingMessage(next),
    };
  }

  handleTurnTimeout(state: TarotState): GameActionResult<TarotState> {
    const next = cloneState(state);
    if (next.status !== 'completed') {
      const drawRes = drawTarotSpread(next.seed, next.spreadType);
      next.seed = drawRes.nextSeed;
      next.drawnCards = drawRes.drawn;
      next.status = 'completed';
    }
    return {
      success: true,
      state: next,
      isGameOver: true,
      winnerJids: [next.host.jid],
      mentions: [next.host.jid],
      broadcastMessage: formatTarotReadingMessage(next),
    };
  }
}
