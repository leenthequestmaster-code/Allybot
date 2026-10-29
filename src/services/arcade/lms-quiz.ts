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
// 4. LMS QUIZ / LAST MAN STANDING ENGINE (JAWABAN RAHASIA VIA DM, RONDE GUGUR)
// ============================================================================

export type QuizOptionKey = 'A' | 'B' | 'C' | 'D';

export interface LmsQuizQuestion {
  readonly id: string;
  readonly category: string;
  readonly prompt: string;
  readonly options: Readonly<Record<QuizOptionKey, string>>;
  readonly correctOption: QuizOptionKey;
  readonly explanation: string;
}

export interface LmsQuizState {
  readonly gameId: string;
  readonly groupJid: string;
  readonly gameType: 'lms_quiz';
  status: 'lobby' | 'question_open' | 'finished';
  seed: number;
  hostJid: string;
  players: GamePlayer[];
  round: number;
  questionDeck: LmsQuizQuestion[];
  currentQuestion: LmsQuizQuestion | null;
  secretAnswers: Record<string, { choice: QuizOptionKey; submittedAt: number }>;
  eliminatedHistory: Array<{ round: number; jid: string; reason: 'wrong' | 'timeout' }>;
  winnerJids: string[];
  wagerAmount: number;
}

export interface LmsQuizAction extends BaseGameAction {
  readonly type: 'JOIN' | 'START' | 'ANSWER' | 'EVALUATE';
  readonly payload?: {
    readonly playerName?: string;
    readonly choice?: string;
    readonly nowMs?: number;
  };
}

export const DEFAULT_LMS_QUIZ_BANK: readonly LmsQuizQuestion[] = [
  {
    id: 'LMS-01',
    category: 'Geografi Indonesia',
    prompt: 'Pulau manakah yang memiliki garis pantai terpanjang dan luas wilayah daratan terbesar yang sepenuhnya berada di kedaulatan Indonesia?',
    options: { A: 'Papua', B: 'Kalimantan', C: 'Sumatra', D: 'Sulawesi' },
    correctOption: 'C',
    explanation: 'Pulau Sumatra adalah pulau terbesar yang seluruh wilayahnya milik Indonesia (Papua dan Kalimantan dibagi dengan negara tetangga).',
  },
  {
    id: 'LMS-02',
    category: 'Sains & Fisika',
    prompt: 'Unsur kimia apakah yang menjadi penyusun paling melimpah di atmosfer Bumi (sekitar 78%)?',
    options: { A: 'Oksigen (O2)', B: 'Karbon Dioksida (CO2)', C: 'Nitrogen (N2)', D: 'Argon (Ar)' },
    correctOption: 'C',
    explanation: 'Atmosfer Bumi tersusun atas ~78% Nitrogen, ~21% Oksigen, dan ~1% gas lainnya.',
  },
  {
    id: 'LMS-03',
    category: 'Sejarah Nusantara',
    prompt: 'Kerajaan maritim bercorak Hindu-Buddha yang berpusat di Palembang sejak abad ke-7 Masehi adalah...',
    options: { A: 'Majapahit', B: 'Sriwijaya', C: 'Kutai Martadipura', D: 'Tarumanagara' },
    correctOption: 'B',
    explanation: 'Kemaharajaan Sriwijaya berpusat di tepian Sungai Musi, Palembang, Sumatra Selatan.',
  },
  {
    id: 'LMS-04',
    category: 'Teknologi & Komputer',
    prompt: 'Berapakah nilai desimal dari bilangan biner 8-bit 11111111 (unsigned)?',
    options: { A: '127', B: '128', C: '255', D: '256' },
    correctOption: 'C',
    explanation: '2^8 - 1 = 255.',
  },
  {
    id: 'LMS-05',
    category: 'Astronomi',
    prompt: 'Planet manakah di Tata Surya yang memiliki arah rotasi berlawanan (retrograde, dari timur ke barat) dibanding Bumi?',
    options: { A: 'Mars', B: 'Venus', C: 'Jupiter', D: 'Neptunus' },
    correctOption: 'B',
    explanation: 'Venus (dan Uranus) berotasi secara retrograde sehingga Matahari terbit dari barat di Venus.',
  },
  {
    id: 'LMS-06',
    category: 'Bahasa Indonesia (KBBI)',
    prompt: 'Manakah penulisan kata baku yang tepat menurut Kamus Besar Bahasa Indonesia (KBBI)?',
    options: { A: 'Apotik', B: 'Praktek', C: 'Cendekiawan', D: 'Resiko' },
    correctOption: 'C',
    explanation: 'Bentuk baku di KBBI adalah Cendekiawan, Apotek, Praktik, dan Risiko.',
  },
  {
    id: 'LMS-07',
    category: 'Logika & Matematika',
    prompt: 'Jika 5 mesin membutuhkan waktu 5 menit untuk memproduksi 5 gawai, berapa waktu yang dibutuhkan 100 mesin untuk memproduksi 100 gawai?',
    options: { A: '100 menit', B: '20 menit', C: '5 menit', D: '1 menit' },
    correctOption: 'C',
    explanation: 'Setiap 1 mesin memproduksi 1 gawai dalam 5 menit; 100 mesin yang bekerja paralel menghasilkan 100 gawai dalam 5 menit.',
  },
  {
    id: 'LMS-08',
    category: 'Biologi',
    prompt: 'Organel sel yang berfungsi sebagai pusat pembangkit energi (sintesis ATP melalui respirasi seluler) adalah...',
    options: { A: 'Ribosom', B: 'Mitokondria', C: 'Lisosom', D: 'Badan Golgi' },
    correctOption: 'B',
    explanation: 'Mitokondria dikenal sebagai the powerhouse of the cell karena menghasilkan ATP.',
  },
  {
    id: 'LMS-09',
    category: 'Ekonomi & Moneter',
    prompt: 'Lembaga negara independen yang memegang otoritas kebijakan moneter dan menjaga kestabilan nilai Rupiah di Indonesia adalah...',
    options: { A: 'Kementerian Keuangan', B: 'Otoritas Jasa Keuangan', C: 'Bank Indonesia', D: 'Lembaga Penjamin Simpanan' },
    correctOption: 'C',
    explanation: 'Bank Indonesia adalah bank sentral Republik Indonesia yang menetapkan dan melaksanakan kebijakan moneter.',
  },
  {
    id: 'LMS-10',
    category: 'Geografi Dunia',
    prompt: 'Selat manakah yang memisahkan Benua Asia (Semenanjung Malaya) dan Pulau Sumatra?',
    options: { A: 'Selat Sunda', B: 'Selat Malaka', C: 'Selat Karimata', D: 'Selat Makassar' },
    correctOption: 'B',
    explanation: 'Selat Malaka terletak di antara Pulau Sumatra dan Semenanjung Malaya.',
  },
];

export class LmsQuizEngine implements GameEngine<LmsQuizState, LmsQuizAction> {
  readonly gameType = 'lms_quiz';
  readonly displayName = 'Last Man Standing (LMS Quiz Rahasia DM)';
  readonly category = 'party' as const;
  readonly minPlayers = 2;
  readonly maxPlayers = 30;
  readonly defaultTurnTimeoutMs = 30_000;

  createInitialState(options: {
    gameId: string;
    groupJid: string;
    host: GamePlayer;
    wagerAmount?: number;
    customConfig?: Record<string, unknown>;
  }): LmsQuizState {
    const initialSeed = resolveInitialSeed(options.customConfig, options.gameId);
    const customQuestions = Array.isArray(options.customConfig?.questions)
      ? (options.customConfig?.questions as LmsQuizQuestion[])
      : DEFAULT_LMS_QUIZ_BANK;

    const shuffled = shuffleWithSeed(customQuestions, initialSeed);

    return {
      gameId: options.gameId,
      groupJid: options.groupJid,
      gameType: 'lms_quiz',
      status: 'lobby',
      seed: shuffled.nextSeed,
      hostJid: options.host.jid,
      players: [
        {
          ...options.host,
          score: options.host.score ?? 0,
          isEliminated: false,
        },
      ],
      round: 0,
      questionDeck: shuffled.items,
      currentQuestion: null,
      secretAnswers: {},
      eliminatedHistory: [],
      winnerJids: [],
      wagerAmount: options.wagerAmount ?? 0,
    };
  }

  private formatQuestionPrompt(state: LmsQuizState): string {
    const q = state.currentQuestion!;
    const aliveCount = state.players.filter((p) => !p.isEliminated).length;
    return [
      `🧠 *LAST MAN STANDING — RONDE ${state.round}* (${aliveCount} Penyintas)`,
      `Kategori: *${q.category}*`,
      '',
      `*Pertanyaan:* ${q.prompt}`,
      `A. ${q.options.A}`,
      `B. ${q.options.B}`,
      `C. ${q.options.C}`,
      `D. ${q.options.D}`,
      '',
      `🔒 *JAWAB VIA DM (JAPRI BOT):* Ketik *A*, *B*, *C*, atau *D* di chat pribadi bot agar jawabanmu tidak dicontek lawan!`,
    ].join('\n');
  }

  private evaluateCurrentRound(next: LmsQuizState): GameActionResult<LmsQuizState> {
    const q = next.currentQuestion;
    if (!q) {
      return { success: false, error: 'Tidak ada pertanyaan aktif untuk dievaluasi.', state: next };
    }

    const alivePlayers = next.players.filter((p) => !p.isEliminated);
    const correctJids: string[] = [];
    const wrongOrTimeout: Array<{ player: GamePlayer; reason: 'wrong' | 'timeout'; choice?: QuizOptionKey }> = [];

    for (const p of alivePlayers) {
      const sub = next.secretAnswers[p.jid];
      if (!sub) {
        wrongOrTimeout.push({ player: p, reason: 'timeout' });
      } else if (sub.choice === q.correctOption) {
        correctJids.push(p.jid);
        p.score = (p.score ?? 0) + 100;
      } else {
        wrongOrTimeout.push({ player: p, reason: 'wrong', choice: sub.choice });
      }
    }

    let mercyApplied = false;
    // Mercy rule: if ZERO alive players answered correctly, nobody is eliminated this round
    if (correctJids.length === 0) {
      mercyApplied = true;
    } else {
      for (const item of wrongOrTimeout) {
        item.player.isEliminated = true;
        next.eliminatedHistory.push({
          round: next.round,
          jid: item.player.jid,
          reason: item.reason,
        });
      }
    }

    const remainingAlive = next.players.filter((p) => !p.isEliminated);
    const roundSummaryLines: string[] = [
      `📊 *HASIL LMS RONDE ${next.round}*`,
      `Jawaban Benar: *${q.correctOption}. ${q.options[q.correctOption]}*`,
      `💡 _${q.explanation}_`,
      '',
    ];

    if (mercyApplied) {
      roundSummaryLines.push(
        `🛡️ *MERCY RULE AKTIF:* Semua penyintas menjawab salah/habis waktu, sehingga tidak ada yang gugur di ronde ini!`,
      );
    } else if (wrongOrTimeout.length > 0) {
      const gugurList = wrongOrTimeout
        .map((w) => `${formatPlayerTag(w.player.jid)} (${w.reason === 'timeout' ? 'Waktu Habis' : `Jawab ${w.choice}`})`)
        .join(', ');
      roundSummaryLines.push(`💀 *Gugur Ronde Ini:* ${gugurList}`);
    } else {
      roundSummaryLines.push(`✅ Seluruh penyintas menjawab benar!`);
    }

    // Check game over conditions
    if (remainingAlive.length === 1) {
      next.status = 'finished';
      next.winnerJids = [remainingAlive[0].jid];
      next.currentQuestion = null;
      roundSummaryLines.push(
        '',
        `🏆 *LAST MAN STANDING CHAMPION:* ${formatPlayerTag(remainingAlive[0].jid)} (${remainingAlive[0].name}) menjadi penyintas tunggal dengan *${remainingAlive[0].score ?? 0} poin*!`,
      );
      return {
        success: true,
        state: next,
        isGameOver: true,
        winnerJids: next.winnerJids,
        mentions: next.players.map((p) => p.jid),
        broadcastMessage: roundSummaryLines.join('\n'),
      };
    }

    if (next.round >= next.questionDeck.length) {
      next.status = 'finished';
      next.winnerJids = remainingAlive.map((p) => p.jid);
      next.currentQuestion = null;
      roundSummaryLines.push(
        '',
        `🏁 *SELURUH RONDE SELESAI!* Penyintas juara: ${remainingAlive.map((p) => formatPlayerTag(p.jid)).join(', ')}`,
      );
      return {
        success: true,
        state: next,
        isGameOver: true,
        winnerJids: next.winnerJids,
        mentions: next.players.map((p) => p.jid),
        broadcastMessage: roundSummaryLines.join('\n'),
      };
    }

    // Advance to next question
    next.round += 1;
    next.currentQuestion = next.questionDeck[next.round - 1];
    next.secretAnswers = {};
    roundSummaryLines.push('', this.formatQuestionPrompt(next));

    return {
      success: true,
      state: next,
      isGameOver: false,
      mentions: remainingAlive.map((p) => p.jid),
      broadcastMessage: roundSummaryLines.join('\n'),
    };
  }

  processAction(state: LmsQuizState, action: LmsQuizAction): GameActionResult<LmsQuizState> {
    const next = cloneState(state);
    const nowMs = action.payload?.nowMs ?? Date.now();

    if (action.type === 'JOIN') {
      if (next.status !== 'lobby') {
        return { success: false, error: 'Kuis Last Man Standing sudah dimulai.', state: next };
      }
      if (next.players.some((p) => p.jid === action.playerJid)) {
        return { success: false, error: 'Kamu sudah terdaftar di lobi LMS Quiz.', state: next };
      }
      if (next.players.length >= this.maxPlayers) {
        return { success: false, error: 'Kapasitas pemain LMS Quiz sudah penuh.', state: next };
      }
      next.players.push({
        jid: action.playerJid,
        name: action.payload?.playerName ?? formatPlayerTag(action.playerJid),
        score: 0,
        isEliminated: false,
        joinedAt: nowMs,
      });
      return {
        success: true,
        state: next,
        mentions: [action.playerJid],
        broadcastMessage: `🧠 ${formatPlayerTag(action.playerJid)} bergabung ke Last Man Standing Quiz! (Total: ${next.players.length} peserta)`,
      };
    }

    if (action.type === 'START') {
      if (next.status !== 'lobby') {
        return { success: false, error: 'Kuis LMS sudah berjalan.', state: next };
      }
      if (next.players.length < this.minPlayers) {
        return {
          success: false,
          error: `Minimal ${this.minPlayers} pemain diperlukan untuk memulai Last Man Standing Quiz.`,
          state: next,
        };
      }
      next.status = 'question_open';
      next.round = 1;
      next.currentQuestion = next.questionDeck[0];
      next.secretAnswers = {};

      return {
        success: true,
        state: next,
        mentions: next.players.map((p) => p.jid),
        broadcastMessage: this.formatQuestionPrompt(next),
      };
    }

    if (next.status !== 'question_open' || !next.currentQuestion) {
      return {
        success: false,
        error: 'Tidak ada sesi pertanyaan LMS Quiz yang sedang terbuka.',
        state: next,
      };
    }

    if (action.type === 'ANSWER') {
      if (!action.isDirectMessage) {
        return {
          success: false,
          error: '🔒 Jawaban LMS Quiz WAJIB dikirim secara rahasia via DM (pesan pribadi ke bot), bukan di grup!',
          state: next,
        };
      }
      const participant = next.players.find((p) => p.jid === action.playerJid);
      if (!participant) {
        return { success: false, error: 'Kamu tidak terdaftar di sesi LMS Quiz ini.', state: next };
      }
      if (participant.isEliminated) {
        return { success: false, error: 'Kamu sudah gugur di ronde sebelumnya.', state: next };
      }
      if (next.secretAnswers[action.playerJid]) {
        return { success: false, error: 'Jawabanmu untuk ronde ini sudah terkunci!', state: next };
      }

      const rawChoice = (action.payload?.choice ?? '').trim().toUpperCase();
      if (!['A', 'B', 'C', 'D'].includes(rawChoice)) {
        return {
          success: false,
          error: 'Pilihan jawaban harus berupa huruf A, B, C, atau D.',
          state: next,
        };
      }
      const choice = rawChoice as QuizOptionKey;
      next.secretAnswers[action.playerJid] = { choice, submittedAt: nowMs };

      const alivePlayers = next.players.filter((p) => !p.isEliminated);
      const answeredCount = alivePlayers.filter((p) => Boolean(next.secretAnswers[p.jid])).length;

      // If all alive players have locked in their secret answers, auto-evaluate the round!
      if (answeredCount >= alivePlayers.length) {
        const evalRes = this.evaluateCurrentRound(next);
        return {
          ...evalRes,
          directMessages: [
            {
              recipientJid: action.playerJid,
              text: `✅ Jawaban rahasia *${choice}* untuk Ronde ${state.round} telah dikunci! Seluruh peserta telah menjawab.`,
            },
          ],
        };
      }

      return {
        success: true,
        state: next,
        broadcastMessage: `🔒 ${formatPlayerTag(action.playerJid)} telah mengunci jawaban rahasia via DM! (${answeredCount}/${alivePlayers.length} penyintas menjawab)`,
        mentions: [action.playerJid],
        directMessages: [
          {
            recipientJid: action.playerJid,
            text: `✅ Jawaban rahasia *${choice} (${next.currentQuestion.options[choice]})* untuk Ronde ${next.round} berhasil dikunci!`,
          },
        ],
      };
    }

    if (action.type === 'EVALUATE') {
      return this.evaluateCurrentRound(next);
    }

    return {
      success: false,
      error: `Aksi LMS Quiz tidak dikenal: ${String(action.type)}`,
      state: next,
    };
  }

  handleTurnTimeout(state: LmsQuizState): GameActionResult<LmsQuizState> {
    const next = cloneState(state);
    if (next.status !== 'question_open') {
      return {
        success: false,
        error: 'Tidak ada ronde pertanyaan LMS yang aktif.',
        state: next,
      };
    }
    return this.evaluateCurrentRound(next);
  }
}
