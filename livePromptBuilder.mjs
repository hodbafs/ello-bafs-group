import { Behavior, Modality, Type } from '@google/genai';

export const LIVE_MODEL = 'gemini-3.8-live';

const VALID_TRACKS = new Set(['work', 'skills']);
const VALID_SKILLS = new Set(['listening', 'speaking', 'reading', 'writing']);
const VALID_CEFR = new Set(['Pre-A1', 'A1', 'A2', 'B1', 'B2']);
const VALID_SCENARIOS = new Set([
  'meetings',
  'presentations',
  'appointments_scheduling',
  'emails_messages',
  'calls_online',
  'everyday_at_work',
  'giving_instructions',
  'troubleshooting_escalation',
]);
const VALID_DIFFICULTIES = new Set(['gentle', 'standard']);

const SCENARIO_CONTEXT_MAP = {
  meetings: 'a team check-in or coordination meeting at BAFS Group',
  presentations: 'a short workplace update presentation and Q&A',
  appointments_scheduling: 'confirming or rescheduling a workplace meeting time',
  emails_messages: 'drafting and verbally rehearsing a polite workplace follow-up message',
  calls_online: 'a phone or online coordination call with a colleague or partner',
  everyday_at_work: 'everyday workplace communication with colleagues at BAFS Group',
  giving_instructions: 'giving or confirming clear step-by-step work instructions',
  troubleshooting_escalation: 'reporting an operational issue and escalating clearly',
};

const CEFR_GUIDE_MAP = {
  'Pre-A1': 'Use very short, simple 4-7 word sentences, everyday basic vocabulary, and speak slowly and warmly.',
  A1: 'Use short, clear sentences, familiar workplace words, and simple present/past structures.',
  A2: 'Use clear everyday workplace English with polite requests ("Could you please...", "Would Thursday work?").',
  B1: 'Use natural, well-structured workplace English with brief follow-up questions and realistic pacing.',
  B2: 'Use fluent, professional workplace English with nuanced tone, summarizing, and natural turn-taking.',
};

function sanitizeRoleLabel(raw) {
  if (typeof raw !== 'string') return 'Team Member';
  return raw.replace(/[\r\n\t<>`]/g, ' ').trim().slice(0, 80) || 'Team Member';
}

export function normalizeLivePracticeInput(input = {}) {
  const track = VALID_TRACKS.has(input.track) ? input.track : 'work';
  const primarySkill = VALID_SKILLS.has(input.primarySkill) ? input.primarySkill : 'speaking';
  const cefrLevel = VALID_CEFR.has(input.cefrLevel) ? input.cefrLevel : 'A2';
  const scenario = VALID_SCENARIOS.has(input.scenario) ? input.scenario : 'meetings';
  const difficulty = VALID_DIFFICULTIES.has(input.difficulty) ? input.difficulty : 'gentle';
  const thaiHelp = Boolean(input.thaiHelp);
  const roleLabel = sanitizeRoleLabel(input.roleLabel);
  const learnerName = sanitizeRoleLabel(input.learnerName || 'Employee');

  return {
    track,
    primarySkill,
    cefrLevel,
    scenario,
    difficulty,
    thaiHelp,
    roleLabel,
    learnerName,
  };
}

export const EMIT_COACH_TIP_DECLARATION = {
  name: 'emit_coach_tip',
  description:
    'Send a silent, non-blocking coaching card to the employee UI with brief Thai encouragement, one polished workplace English phrasing, and a short Thai explanation. Call this asynchronously after a meaningful user turn without stopping or repeating the same text in voice.',
  behavior: Behavior.NON_BLOCKING,
  parameters: {
    type: Type.OBJECT,
    properties: {
      encouragement_th: {
        type: Type.STRING,
        description: 'Warm, concise encouragement in Thai (1 short sentence).',
      },
      suggested_phrase_en: {
        type: Type.STRING,
        description: 'One natural, polite workplace English sentence the learner can save to their phrasebook.',
      },
      explanation_th: {
        type: Type.STRING,
        description: 'Brief 1-sentence Thai tip explaining why this phrasing works well at work.',
      },
    },
    required: ['encouragement_th', 'suggested_phrase_en', 'explanation_th'],
  },
};

export function buildLiveSystemInstruction(rawInput = {}) {
  const cfg = normalizeLivePracticeInput(rawInput);
  const scenarioDesc = SCENARIO_CONTEXT_MAP[cfg.scenario] ?? SCENARIO_CONTEXT_MAP.meetings;
  const cefrGuide = CEFR_GUIDE_MAP[cfg.cefrLevel] ?? CEFR_GUIDE_MAP.A2;

  const trackLine =
    cfg.track === 'skills'
      ? `Practice Track: English Skills focus on "${cfg.primarySkill}" at CEFR level ${cfg.cefrLevel}.`
      : `Practice Track: English at Work scenario (${scenarioDesc}). Learner role: "${cfg.roleLabel}".`;

  const difficultyLine =
    cfg.difficulty === 'gentle'
      ? 'Coaching pacing: Gentle — keep turns short (1-3 sentences), allow space for the learner, and give reassuring verbal cues.'
      : 'Coaching pacing: Standard — realistic workplace dialogue pace with natural follow-up questions.';

  const thaiLine = cfg.thaiHelp
    ? 'Thai Scaffolding: ON — Speak English during the roleplay, and switch to brief, friendly Thai ONLY when the learner pauses for help, asks in Thai, or seems stuck, then invite them back into English.'
    : 'Thai Scaffolding: OFF — Keep spoken dialogue in clear English.';

  return [
    'You are "Nong ELLO", a friendly, supportive workplace English speaking partner for employees at BAFS Group.',
    `Learner: ${cfg.learnerName}.`,
    trackLine,
    `Target Level Guidance (${cfg.cefrLevel}): ${cefrGuide}`,
    difficultyLine,
    thaiLine,
    'Conversation Rules:',
    '1. Natural Flow: Stay in the conversational flow like a real phone/voice call. Never deliver long grammar lectures aloud.',
    '2. Opening: Greet briefly in character and ask one simple opening question to start the scenario right away.',
    '3. Live Coach Cards: After meaningful learner utterances where a polite phrasing upgrade or praise helps, call the non-blocking tool `emit_coach_tip` quietly in the background while continuing the conversation naturally.',
    '4. Safety & Privacy: Never ask for passwords, employee IDs, confidential operational data, or personal sensitive information.',
  ].join('\n');
}

export function buildLiveConnectConfig(rawInput = {}) {
  return {
    responseModalities: [Modality.AUDIO],
    speechConfig: {
      voiceConfig: {
        prebuiltVoiceConfig: {
          voiceName: 'Puck',
        },
      },
    },
    systemInstruction: {
      parts: [{ text: buildLiveSystemInstruction(rawInput) }],
    },
    inputAudioTranscription: {},
    outputAudioTranscription: {},
    tools: [
      {
        functionDeclarations: [EMIT_COACH_TIP_DECLARATION],
      },
    ],
  };
}
