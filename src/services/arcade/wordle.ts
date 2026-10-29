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
// 1. WORDLE ENGINE (TEBAK KATA 5 HURUF KBBI, 6 PERCOBAAN)
// ============================================================================

export type WordleLetterStatus = 'correct' | 'present' | 'absent';

export interface WordleLetterCell {
  readonly letter: string;
  readonly status: WordleLetterStatus;
  readonly emoji: '🟩' | '🟨' | '⬛';
}

export interface WordleAttemptRecord {
  readonly attemptNumber: number;
  readonly playerJid: string;
  readonly playerName: string;
  readonly word: string;
  readonly cells: readonly WordleLetterCell[];
  readonly emojiRow: string;
  readonly timestamp: number;
}

export interface WordleState {
  readonly gameId: string;
  readonly groupJid: string;
  readonly gameType: 'wordle';
  status: 'playing' | 'won' | 'lost';
  seed: number;
  targetWord: string;
  maxAttempts: number;
  strictDictionary: boolean;
  players: Record<string, GamePlayer>;
  attempts: WordleAttemptRecord[];
  keyboardStatus: Record<string, WordleLetterStatus>;
  winnerJid?: string;
  wagerAmount: number;
  startedAt: number;
}

export interface WordleAction extends BaseGameAction {
  readonly type: 'JOIN' | 'GUESS' | 'TEBAK' | 'GIVE_UP';
  readonly payload?: {
    readonly word?: string;
    readonly playerName?: string;
    readonly nowMs?: number;
  } | string;
}

export const KBBI_5_LETTER_WORDS: readonly string[] = [
  'ABJAD', 'AGAMA', 'AKHIR', 'AKSES', 'AKTIF', 'ALAMI', 'ALBUM', 'ANGIN',
  'ANGKA', 'ANTAR', 'APELU', 'ARENA', 'ARSIP', 'ASPEK', 'ATLET', 'AWANI',
  'BADAI', 'BAGUS', 'BAHAN', 'BAKAT', 'BALON', 'BANTU', 'BARAT', 'BARIS',
  'BATAS', 'BATIK', 'BAYAR', 'BEBAN', 'BEBAS', 'BEDAH', 'BEKAL', 'BENAR',
  'BENIH', 'BERAS', 'BERAT', 'BESAR', 'BETUL', 'BIAYA', 'BIBIT', 'BIJAK',
  'BINTI', 'BISIK', 'BOCOR', 'BONUS', 'BOTOL', 'BUAYA', 'BUKIT', 'BULAN',
  'BUNGA', 'BURUH', 'BURUK', 'CABAI', 'CADAR', 'CAKRA', 'CALON', 'CAMAT',
  'CANDI', 'CAPAI', 'CATUR', 'CEPAT', 'CERAH', 'CERIA', 'CETAK', 'CINTA',
  'CIPTA', 'CUACA', 'CURAM', 'DADAR', 'DAHAN', 'DALAM', 'DAMAI', 'DANAU',
  'DAPUR', 'DARAH', 'DARAT', 'DASAR', 'DATAR', 'DAWAI', 'DEBAT', 'DEKAT',
  'DEMAM', 'DENDA', 'DEPAN', 'DERAS', 'DETIK', 'DEWAN', 'DINAS', 'DOKOK',
  'DOMBA', 'DONOR', 'DOSEN', 'DRAMA', 'DUDUK', 'DUNIA', 'DUREN', 'DUSUN',
  'ELANG', 'EMOSI', 'ENJIN', 'FAJAR', 'FAKTA', 'FAUNA', 'FLORA', 'FOKUS',
  'FORUM', 'GADIS', 'GAJAH', 'GALAU', 'GAMIS', 'GANDA', 'GANJA', 'GARAM',
  'GARIS', 'GARPU', 'GAWAI', 'GELAP', 'GELAS', 'GEMPA', 'GENAP', 'GERAK',
  'GETAR', 'GIGIH', 'GILIR', 'GITAR', 'GUBUK', 'GULAI', 'GURUN', 'HABIS',
  'HADIR', 'HAFAL', 'HAKIM', 'HALAL', 'HALUS', 'HAMPA', 'HANYA', 'HARAP',
  'HARGA', 'HARUM', 'HASIL', 'HEMAT', 'HEWAN', 'HIDUP', 'HIJAU', 'HILIR',
  'HITAM', 'HOTEL', 'HUJAN', 'HUTAN', 'IKLAN', 'IKLIM', 'IMPAS', 'INDAH',
  'INDUK', 'INGAT', 'INTAN', 'IRAMA', 'ISTRI', 'JADUL', 'JAGAD', 'JAHIT',
  'JALAN', 'JALUR', 'JAMUR', 'JARAK', 'JARUM', 'JATUH', 'JAWAB', 'JELAS',
  'JEMUR', 'JENIS', 'JERUK', 'JIJIK', 'JUARA', 'JUDUL', 'JUJUR', 'KABAR',
  'KABEL', 'KABUT', 'KACAU', 'KADAR', 'KAGUM', 'KAKAK', 'KALAH', 'KALEM',
  'KAMAR', 'KAMUS', 'KANAN', 'KAPAL', 'KAPAS', 'KAPUR', 'KARTU', 'KARYA',
  'KASAR', 'KASIH', 'KASUR', 'KAWAN', 'KAWAT', 'KAYUH', 'KEBUN', 'KECIL',
  'KEDAI', 'KEJAM', 'KEJAR', 'KEJUT', 'KEKAL', 'KELAS', 'KELOR', 'KENAL',
  'KERAS', 'KERIS', 'KERJA', 'KESAN', 'KETAT', 'KILAT', 'KIMIA', 'KIPAS',
  'KIRIM', 'KISAH', 'KOLAM', 'KOMIK', 'KOTAK', 'KOTOR', 'KUASA', 'KUBIS',
  'KUBUR', 'KULIT', 'KUNCI', 'KURSI', 'KURUS', 'LABIL', 'LADEN', 'LAHAN',
  'LAHIR', 'LAJUR', 'LAKON', 'LALAI', 'LAMPU', 'LANCI', 'LANGU', 'LAPAR',
  'LAPIS', 'LARIS', 'LARUT', 'LAWAK', 'LAWAN', 'LAYAK', 'LAYAR', 'LEBAH',
  'LEBAR', 'LEBIH', 'LEHER', 'LEKAS', 'LELAH', 'LEMAH', 'LEMAK', 'LEPAS',
  'LERAI', 'LETAK', 'LIDAH', 'LIHAT', 'LILIN', 'LIMAU', 'LINCA', 'LIPAT',
  'LISAN', 'LOGAM', 'LOGIS', 'LOKAL', 'LOMBA', 'LORIK', 'LUANG', 'LUBUR',
  'LULUS', 'LUMUT', 'LUNAK', 'LURUS', 'LUTUT', 'MACAN', 'MAHAL', 'MAHIR',
  'MAKAN', 'MAKNA', 'MALAM', 'MALAS', 'MAMPU', 'MANDI', 'MANIS', 'MARAH',
  'MARGA', 'MASAK', 'MASIH', 'MASUK', 'MAWAR', 'MEDAN', 'MEDIA', 'MEGAH',
  'MEKAR', 'MELON', 'MENIT', 'MERAH', 'MERDU', 'MESIN', 'MESRA', 'METRO',
  'MEWAH', 'MIMPI', 'MINUM', 'MIRIP', 'MISKI', 'MITOS', 'MITRA', 'MOBIL',
  'MODAL', 'MODEL', 'MODEM', 'MORAL', 'MOTIF', 'MOTOR', 'MUARA', 'MUDAH',
  'MULIA', 'MULUT', 'MURAH', 'MURID', 'MURNI', 'MUSIK', 'MUSIM', 'MUSUH',
  'NAFAS', 'NAKAL', 'NALAR', 'NANAS', 'NAPAS', 'NASIB', 'NEKAT', 'NENEK',
  'NILAI', 'NOMOR', 'NORMA', 'NYALA', 'NYATA', 'OBENG', 'OMBAK', 'OPINI',
  'ORANG', 'ORGAN', 'PADAM', 'PADAT', 'PAGAR', 'PAHAM', 'PAHIT', 'PAJAK',
  'PAKAI', 'PAKAR', 'PAKET', 'PAKSA', 'PALSU', 'PAMAN', 'PAMER', 'PANAS',
  'PANCI', 'PANDU', 'PANEN', 'PAPAN', 'PARAH', 'PASAR', 'PASIR', 'PASTI',
  'PATAH', 'PATUH', 'PATUT', 'PECAH', 'PEDAS', 'PEDUL', 'PEGAL', 'PEKAN',
  'PEKAT', 'PELAN', 'PELUK', 'PENUH', 'PERAK', 'PERAN', 'PERLU', 'PESAN',
  'PESTA', 'PETIR', 'PIALA', 'PIJAT', 'PIKIR', 'PILIH', 'PILOT', 'PINDA',
  'PINTU', 'PIPIT', 'PISAH', 'PISAU', 'POHON', 'POKOK', 'POLOS', 'POMPA',
  'POROS', 'PUASA', 'PUCAT', 'PUISI', 'PUKUL', 'PULAU', 'PULIH', 'PUNCA',
  'PUPUK', 'PUSAT', 'PUTAR', 'PUTIH', 'PUTUS', 'RACUN', 'RADAR', 'RAGAM',
  'RAHIM', 'RAJIN', 'RAKIT', 'RAMAH', 'RAMAI', 'RAMBU', 'RANAH', 'RAPAT',
  'RAPIH', 'RASIO', 'RAWAN', 'RAWAT', 'RAYAP', 'REBAH', 'REBUS', 'REDUP',
  'REKAM', 'REKAN', 'REMAJ', 'RETAK', 'RINDU', 'RINGA', 'RISAU', 'ROBOH',
  'ROKOK', 'ROMPI', 'ROTAN', 'RUANG', 'RUMAH', 'RUMIT', 'RUMUS', 'RUSAK',
  'RUSUH', 'SABAR', 'SABTU', 'SABUK', 'SABUN', 'SADAR', 'SAHAM', 'SAKIT',
  'SAKSI', 'SAKTI', 'SALAH', 'SALAM', 'SALJU', 'SAMAR', 'SAMBU', 'SAMPA',
  'SANAK', 'SANDI', 'SANGA', 'SARAF', 'SARAN', 'SARAP', 'SARAT', 'SAWAH',
  'SAWIT', 'SAYAP', 'SAYUR', 'SEBAB', 'SEBAR', 'SEDIH', 'SEDOT', 'SEGAR',
  'SEHAT', 'SEJAK', 'SEJUK', 'SEKAM', 'SEKAT', 'SELAM', 'SELAT', 'SELIP',
  'SEMAK', 'SEMUA', 'SEMUT', 'SENAM', 'SENDI', 'SENJA', 'SENJU', 'SEPAK',
  'SEPAT', 'SEPUP', 'SERAH', 'SERAK', 'SERAM', 'SERAT', 'SERBU', 'SERET',
  'SERIK', 'SESAK', 'SESAT', 'SETIA', 'SIAGA', 'SIANG', 'SIKAP', 'SIKAT',
  'SIKSA', 'SILAU', 'SIMAK', 'SINAR', 'SINGA', 'SIRAM', 'SIRIP', 'SISWA',
  'SKALA', 'SOPAN', 'SUARA', 'SUASA', 'SUBUR', 'SUDAH', 'SUDUT', 'SUKMA',
  'SUKUN', 'SULIT', 'SUMUR', 'SUNYI', 'SURAT', 'SURGA', 'SURUT', 'SUSAH',
  'SUSUN', 'SUTRA', 'SYAIR', 'TABAH', 'TABEL', 'TABIR', 'TABUR', 'TAHAN',
  'TAHAP', 'TAHUN', 'TAJAM', 'TAKUT', 'TALAS', 'TAMAN', 'TAMAT', 'TAMUR',
  'TANAH', 'TANAM', 'TANDA', 'TANDU', 'TANGI', 'TANPA', 'TANYA', 'TAPAK',
  'TARIK', 'TARUH', 'TATAP', 'TAWAN', 'TAWAR', 'TEBAK', 'TEBAL', 'TEBAR',
  'TEBAS', 'TEDUH', 'TEGAK', 'TEGAS', 'TEGUH', 'TEKAD', 'TEKAN', 'TEKUN',
  'TELAH', 'TELAN', 'TELAT', 'TELUR', 'TEMAN', 'TEMPA', 'TEMPO', 'TENDA',
  'TENGU', 'TENOR', 'TEORI', 'TEPAT', 'TEPIK', 'TERAN', 'TERAS', 'TERIK',
  'TERNA', 'TERUS', 'TETAP', 'TETES', 'TIANG', 'TIDAK', 'TIDUR', 'TIKET',
  'TIKUS', 'TIMBA', 'TIMUR', 'TINDA', 'TINGI', 'TINJU', 'TIPIS', 'TIRAI',
  'TIRAM', 'TITIK', 'TOKOH', 'TOLAK', 'TOLOL', 'TOMAT', 'TOPAN', 'TOPIK',
  'TOTAL', 'TRUKO', 'TUGAS', 'TUHAN', 'TUJUH', 'TUKAR', 'TULIS', 'TULUS',
  'TUMIS', 'TUMOR', 'TUNAI', 'TUNAS', 'TUNDA', 'TURUN', 'TUTUP', 'UDARA',
  'UJIAN', 'UJUNG', 'UKRAN', 'ULAMA', 'ULANG', 'UMPAT', 'UNSUR', 'UNTUK',
  'UPAYA', 'USAHA', 'UTAMA', 'UTARA', 'WAJAH', 'WAJAR', 'WAJIB', 'WAKIL',
  'WAKTU', 'WALAU', 'WARGA', 'WARIS', 'WARNA', 'WARTA', 'WASIT', 'WATAK',
  'WUJUD', 'YAKIN', 'ZAKAT', 'ZAMAN',
];

/**
 * Pure two-pass Wordle evaluation algorithm handling duplicate letters accurately.
 */
export function evaluateWordleGuess(guessInput: string, targetInput: string): WordleLetterCell[] {
  const guess = guessInput.trim().toUpperCase();
  const target = targetInput.trim().toUpperCase();
  const statuses: WordleLetterStatus[] = new Array(5).fill('absent');
  const remainingCounts: Record<string, number> = {};

  // Pass 1: Exact position matches ('correct')
  for (let i = 0; i < 5; i++) {
    const gChar = guess[i];
    const tChar = target[i];
    if (gChar === tChar) {
      statuses[i] = 'correct';
    } else {
      remainingCounts[tChar] = (remainingCounts[tChar] ?? 0) + 1;
    }
  }

  // Pass 2: Misplaced letters ('present') respecting remaining target letter counts
  for (let i = 0; i < 5; i++) {
    if (statuses[i] === 'correct') continue;
    const gChar = guess[i];
    if ((remainingCounts[gChar] ?? 0) > 0) {
      statuses[i] = 'present';
      remainingCounts[gChar] -= 1;
    }
  }

  return Array.from({ length: 5 }, (_, i) => {
    const status = statuses[i];
    const emoji = status === 'correct' ? '🟩' : status === 'present' ? '🟨' : '⬛';
    return {
      letter: guess[i],
      status,
      emoji,
    };
  });
}

export class WordleEngine implements GameEngine<WordleState, WordleAction> {
  readonly gameType = 'wordle';
  readonly displayName = 'Wordle Indonesia (5 Huruf KBBI)';
  readonly category = 'grid' as const;
  readonly minPlayers = 1;
  readonly maxPlayers = 20;
  readonly defaultTurnTimeoutMs = 180_000;

  createInitialState(options: {
    gameId: string;
    groupJid: string;
    host: GamePlayer;
    wagerAmount?: number;
    customConfig?: Record<string, unknown>;
  }): WordleState {
    const initialSeed = resolveInitialSeed(options.customConfig, options.gameId);
    const customTarget = typeof options.customConfig?.targetWord === 'string'
      ? options.customConfig.targetWord.trim().toUpperCase()
      : undefined;

    let targetWord = 'CATUR';
    let nextSeed = initialSeed;
    if (customTarget && /^[A-Z]{5}$/.test(customTarget)) {
      targetWord = customTarget;
    } else {
      const pick = nextInt(initialSeed, 0, KBBI_5_LETTER_WORDS.length - 1);
      targetWord = KBBI_5_LETTER_WORDS[pick.value] ?? 'CATUR';
      nextSeed = pick.nextSeed;
    }

    const maxAttempts = typeof options.customConfig?.maxAttempts === 'number'
      ? Math.max(1, Math.min(10, Math.floor(options.customConfig.maxAttempts)))
      : 6;

    const strictDictionary = Boolean(options.customConfig?.strictDictionary ?? false);

    return {
      gameId: options.gameId,
      groupJid: options.groupJid,
      gameType: 'wordle',
      status: 'playing',
      seed: nextSeed,
      targetWord,
      maxAttempts,
      strictDictionary,
      players: {
        [options.host.jid]: {
          ...options.host,
          score: options.host.score ?? 0,
        },
      },
      attempts: [],
      keyboardStatus: {},
      wagerAmount: options.wagerAmount ?? 0,
      startedAt: Date.now(),
    };
  }

  processAction(state: WordleState, action: WordleAction): GameActionResult<WordleState> {
    const next = cloneState(state);

    if (next.status !== 'playing') {
      return {
        success: false,
        error: 'Permainan Wordle ini sudah selesai.',
        state: next,
        isGameOver: true,
        winnerJids: next.winnerJid ? [next.winnerJid] : [],
      };
    }

    const payloadObj = typeof action.payload === 'object' && action.payload !== null
      ? action.payload
      : {};
    const playerName =
      (payloadObj as { playerName?: string }).playerName ??
      next.players[action.playerJid]?.name ??
      formatPlayerTag(action.playerJid);

    if (!next.players[action.playerJid]) {
      if (Object.keys(next.players).length >= this.maxPlayers) {
        return {
          success: false,
          error: 'Jumlah pemain Wordle sudah mencapai batas maksimum.',
          state: next,
        };
      }
      next.players[action.playerJid] = {
        jid: action.playerJid,
        name: playerName,
        score: 0,
        joinedAt: Date.now(),
      };
    }

    if (action.type === 'JOIN') {
      return {
        success: true,
        state: next,
        broadcastMessage: `🟩 ${formatPlayerTag(action.playerJid)} bergabung ke sesi Wordle! Ketik kata 5 huruf untuk menebak.`,
        mentions: [action.playerJid],
      };
    }

    if (action.type === 'GIVE_UP') {
      next.status = 'lost';
      return {
        success: true,
        state: next,
        isGameOver: true,
        winnerJids: [],
        broadcastMessage: `🏳️ Permainan Wordle dihentikan. Kata rahasianya adalah *${next.targetWord}*.`,
        mentions: [action.playerJid],
      };
    }

    if (action.type !== 'GUESS' && action.type !== 'TEBAK') {
      return {
        success: false,
        error: `Aksi Wordle tidak dikenal: ${String(action.type)}`,
        state: next,
      };
    }

    const rawWord = typeof action.payload === 'string'
      ? action.payload
      : (payloadObj as { word?: string }).word ?? '';
    const guess = rawWord.trim().toUpperCase();

    if (!/^[A-Z]{5}$/.test(guess)) {
      return {
        success: false,
        error: 'Tebakan wajib berupa kata 5 huruf alfabet (A-Z) tanpa spasi atau angka.',
        state: next,
      };
    }

    if (
      next.strictDictionary &&
      guess !== next.targetWord &&
      !KBBI_5_LETTER_WORDS.includes(guess)
    ) {
      return {
        success: false,
        error: `Kata *${guess}* tidak ditemukan di kamus 5 huruf KBBI.`,
        state: next,
      };
    }

    const cells = evaluateWordleGuess(guess, next.targetWord);
    const emojiRow = cells.map((c) => c.emoji).join('');
    const attemptNumber = next.attempts.length + 1;

    const record: WordleAttemptRecord = {
      attemptNumber,
      playerJid: action.playerJid,
      playerName,
      word: guess,
      cells,
      emojiRow,
      timestamp: (payloadObj as { nowMs?: number }).nowMs ?? Date.now(),
    };
    next.attempts.push(record);

    // Update keyboard status priority: correct > present > absent
    const rankMap: Record<WordleLetterStatus, number> = {
      absent: 1,
      present: 2,
      correct: 3,
    };
    for (const cell of cells) {
      const current = next.keyboardStatus[cell.letter];
      if (!current || rankMap[cell.status] > rankMap[current]) {
        next.keyboardStatus[cell.letter] = cell.status;
      }
    }

    const boardHistoryLines = next.attempts.map(
      (a) => `${a.attemptNumber}/${next.maxAttempts} ${a.emojiRow}  *${a.word}* (${a.playerName})`,
    );

    if (guess === next.targetWord) {
      next.status = 'won';
      next.winnerJid = action.playerJid;
      const bonusScore = (next.maxAttempts - attemptNumber + 1) * 20;
      next.players[action.playerJid].score = (next.players[action.playerJid].score ?? 0) + bonusScore;

      return {
        success: true,
        state: next,
        isGameOver: true,
        winnerJids: [action.playerJid],
        mentions: [action.playerJid],
        broadcastMessage: [
          `🎉 *WORDLE TERPECAHKAN!* (${attemptNumber}/${next.maxAttempts})`,
          '',
          ...boardHistoryLines,
          '',
          `Pemenang: ${formatPlayerTag(action.playerJid)} (+${bonusScore} poin) • Jawaban: *${next.targetWord}*`,
        ].join('\n'),
      };
    }

    if (attemptNumber >= next.maxAttempts) {
      next.status = 'lost';
      return {
        success: true,
        state: next,
        isGameOver: true,
        winnerJids: [],
        mentions: [action.playerJid],
        broadcastMessage: [
          `💀 *KESEMPATAN HABIS!* (${attemptNumber}/${next.maxAttempts})`,
          '',
          ...boardHistoryLines,
          '',
          `Kata rahasia yang benar adalah: *${next.targetWord}*`,
        ].join('\n'),
      };
    }

    return {
      success: true,
      state: next,
      isGameOver: false,
      mentions: [action.playerJid],
      broadcastMessage: [
        `🧩 *WORDLE INDONESIA* — Percobaan ${attemptNumber}/${next.maxAttempts}`,
        '',
        ...boardHistoryLines,
        '',
        `Sisa kesempatan: *${next.maxAttempts - attemptNumber}* percobaan.`,
      ].join('\n'),
    };
  }

  handleTurnTimeout(state: WordleState): GameActionResult<WordleState> {
    const next = cloneState(state);
    if (next.status === 'playing') {
      next.status = 'lost';
    }
    return {
      success: true,
      state: next,
      isGameOver: true,
      winnerJids: [],
      broadcastMessage: `⏰ *WAKTU WORDLE HABIS!* Kata rahasianya adalah *${next.targetWord}*.`,
    };
  }
}
