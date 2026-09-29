// 개인 수업(1:1)의 AI 선생님 역할을 실제 Claude API로 구현한다: 오늘의 학습 주제를 학년
// 페르소나에 맞춰 고르고(startLesson), 학생 질문에 답한다(answerLessonQuestion).
//
// 승급 시험(getExamQuestions)/근무 문제(getWorkQuestions)/채점(gradeAnswer)은 계속 MockAIProvider의
// 고정 문제은행에 위임한다 — 게임 진행(승급/급여)이 LLM의 비결정적 출력에 좌우되면 안 되기 때문.
//
// API 키가 없거나 호출이 실패하면(네트워크 오류, 인증 실패 등) MockAIProvider의 캔드 응답으로
// 조용히 대체한다 — Phase 1의 원래 설계 의도("외부 LLM API 키 없이도 전체 플로우 검증 가능")를
// 그대로 유지하면서, 키가 있을 때만 실제 LLM 응답으로 자연스럽게 전환되게 하기 위함이다.
//
// 2026-08-30: 짧은 채팅 답변/한 줄 주제 선정에는 최상위 모델(claude-opus-5)이 과분해서
// 비용 대비 가장 저렴한 claude-haiku-4-5로 낮췄다. GeminiAIProvider.ts와 동일하게, 이번 달
// 누적 호출 비용이 MONTHLY_BUDGET_USD를 넘으면 실제 호출을 건너뛰고 곧바로
// MockAIProvider(고정 응답)로 대체한다 — db.ts의 ai_usage 테이블에 두 Provider가 비용을
// 공유해서 누적하므로, 어느 쪽을 쓰든 합산 기준으로 예산이 지켜진다.
import Anthropic from "@anthropic-ai/sdk";
import type {
  AIProvider,
  BoardCommand,
  ColleagueChatTurn,
  ColleagueContext,
  ColleagueProfile,
  ColleagueTurn,
  ConversationMemory,
  ConversationTurn,
  ExamQuestion,
  LessonReply,
  LessonStart,
  StudentUtterance,
} from "./AIProvider.js";
import { addAiCostUsd, getMonthlyAiCostUsd } from "../db.js";
import { MockAIProvider } from "./MockAIProvider.js";
import { parseLessonReplyJson, parseLessonStartJson } from "./lessonJson.js";
import { parseColleagueTurn } from "./colleagueJson.js";
import {
  colleagueSummarySystemPrompt,
  colleagueSummaryUserPrompt,
  colleagueSystemPrompt,
  colleagueUserPrompt,
  lessonAnswerUserPrompt,
  lessonStartUserPrompt,
  lessonSystemPrompt,
  summarySystemPrompt,
  summaryUserPrompt,
  npcVoiceSystemPrompt,
  npcVoiceUserPrompt,
  teacherSystemPrompt,
  teacherUserPrompt,
  topicSystemPrompt,
  topicUserPrompt,
} from "./promptHelpers.js";

const MODEL = "claude-haiku-4-5-20251001"; // 저비용 모델(MODEL 바꾸면 아래 가격 상수도 같이 갱신)
const PRICE_PER_1M_INPUT_USD = 1;
const PRICE_PER_1M_OUTPUT_USD = 5;
const MONTHLY_BUDGET_USD = 5;

export class ClaudeAIProvider implements AIProvider {
  // 모듈 로드 시점(서버 기동 시)에는 절대 예외가 나면 안 되므로, 클라이언트는 첫 호출 시점에
  // try/catch 안에서 지연 생성한다 — 자격 증명이 전혀 없어도 서버 자체는 정상 기동해야 한다.
  private client: Anthropic | null = null;
  private readonly fallback = new MockAIProvider();
  private warned = false;

  private warnOnce(context: string, err: unknown): void {
    if (this.warned) return;
    this.warned = true;
    const message = err instanceof Error ? err.message : String(err);
    console.warn(
      `[ai] Claude API 호출 실패(${context}) — 이후 AI 선생님 응답은 MockAIProvider(고정 응답)로 대체합니다:`,
      message
    );
  }

  private async complete(system: string, userText: string, maxTokens = 400): Promise<string> {
    const spent = getMonthlyAiCostUsd();
    if (spent >= MONTHLY_BUDGET_USD) {
      throw new Error(
        `이번 달 AI 호출 비용이 예산($${MONTHLY_BUDGET_USD})을 넘어(현재 $${spent.toFixed(
          4
        )}) 실제 호출을 건너뜁니다.`
      );
    }

    if (!this.client) this.client = new Anthropic();
    const response = await this.client.messages.create({
      model: MODEL,
      max_tokens: maxTokens,
      system,
      messages: [{ role: "user", content: userText }],
    });
    const textBlock = response.content.find((b): b is Anthropic.TextBlock => b.type === "text");
    const text = textBlock?.text.trim();
    if (!text) throw new Error("응답에 텍스트 블록이 없습니다.");

    const cost =
      (response.usage.input_tokens / 1_000_000) * PRICE_PER_1M_INPUT_USD +
      (response.usage.output_tokens / 1_000_000) * PRICE_PER_1M_OUTPUT_USD;
    addAiCostUsd(cost);

    return text;
  }

  async pickDiscussionTopic(
    schoolLevel: string,
    grade: number,
    recentMessages: StudentUtterance[],
    avoidTopics: string[] = []
  ): Promise<string> {
    try {
      const text = await this.complete(
        topicSystemPrompt(schoolLevel, grade),
        topicUserPrompt(schoolLevel, grade, recentMessages, avoidTopics)
      );
      // 한 줄만 쓰라고 지시했지만 혹시 여러 줄이 오면 첫 줄만, 너무 길면 잘라서 방어한다.
      const firstLine = text.split("\n")[0].trim().replace(/^["'“”]|["'“”]$/g, "");
      if (!firstLine) throw new Error("빈 주제 응답");
      return firstLine.slice(0, 60);
    } catch (err) {
      this.warnOnce("pickDiscussionTopic", err);
      return this.fallback.pickDiscussionTopic(schoolLevel, grade, recentMessages, avoidTopics);
    }
  }

  async npcLine(npc: "manager" | "boss", situation: string, baseLine: string): Promise<string> {
    try {
      const text = await this.complete(npcVoiceSystemPrompt(npc), npcVoiceUserPrompt(situation, baseLine), 200);
      return text.split(/\r?\n/)[0].trim().replace(/^["'“”]|["'“”]$/g, "") || baseLine;
    } catch (err) {
      this.warnOnce("npcLine", err);
      return baseLine;
    }
  }

  async colleagueReply(ctx: ColleagueContext): Promise<ColleagueTurn> {
    try {
      const text = await this.complete(colleagueSystemPrompt(ctx), colleagueUserPrompt(ctx), 300);
      return parseColleagueTurn(text);
    } catch (err) {
      this.warnOnce("colleagueReply", err);
      return this.fallback.colleagueReply(ctx);
    }
  }

  async summarizeColleagueMemory(
    colleague: ColleagueProfile,
    previousSummary: string | null,
    turns: ColleagueChatTurn[]
  ): Promise<string> {
    try {
      return await this.complete(
        colleagueSummarySystemPrompt(colleague),
        colleagueSummaryUserPrompt(colleague, previousSummary, turns),
        400
      );
    } catch (err) {
      this.warnOnce("summarizeColleagueMemory", err);
      return this.fallback.summarizeColleagueMemory(colleague, previousSummary, turns);
    }
  }

  async teacherReplyToBatch(
    topic: string,
    utterances: StudentUtterance[],
    schoolLevel: string,
    grade: number,
    memory?: ConversationMemory | null
  ): Promise<string> {
    if (utterances.length === 0) {
      return this.fallback.teacherReplyToBatch(topic, utterances, schoolLevel, grade, memory);
    }
    try {
      return await this.complete(
        teacherSystemPrompt(schoolLevel, grade),
        teacherUserPrompt(topic, utterances, memory)
      );
    } catch (err) {
      this.warnOnce("teacherReplyToBatch", err);
      return this.fallback.teacherReplyToBatch(topic, utterances, schoolLevel, grade, memory);
    }
  }

  async summarizeConversation(
    schoolLevel: string,
    grade: number,
    topic: string,
    previousSummary: string | null,
    turns: ConversationTurn[]
  ): Promise<string> {
    try {
      return await this.complete(
        summarySystemPrompt(schoolLevel, grade),
        summaryUserPrompt(topic, previousSummary, turns)
      );
    } catch (err) {
      this.warnOnce("summarizeConversation", err);
      return this.fallback.summarizeConversation(schoolLevel, grade, topic, previousSummary, turns);
    }
  }

  async startLesson(schoolLevel: string, grade: number, avoidTopics: string[] = []): Promise<LessonStart> {
    try {
      const text = await this.complete(
        lessonSystemPrompt(schoolLevel, grade),
        lessonStartUserPrompt(schoolLevel, grade, avoidTopics),
        900
      );
      return parseLessonStartJson(text);
    } catch (err) {
      this.warnOnce("startLesson", err);
      return this.fallback.startLesson(schoolLevel, grade, avoidTopics);
    }
  }

  async answerLessonQuestion(
    topic: string,
    schoolLevel: string,
    grade: number,
    question: string,
    memory: ConversationMemory | null,
    currentBoard: BoardCommand[]
  ): Promise<LessonReply> {
    try {
      const text = await this.complete(
        lessonSystemPrompt(schoolLevel, grade),
        lessonAnswerUserPrompt(topic, question, memory, currentBoard),
        900
      );
      return parseLessonReplyJson(text);
    } catch (err) {
      this.warnOnce("answerLessonQuestion", err);
      return this.fallback.answerLessonQuestion(topic, schoolLevel, grade, question, memory, currentBoard);
    }
  }

  getExamQuestions(schoolLevel: string, grade: number): ExamQuestion[] {
    return this.fallback.getExamQuestions(schoolLevel, grade);
  }

  getPlacementQuestions(schoolLevel: string): ExamQuestion[] {
    return this.fallback.getPlacementQuestions(schoolLevel);
  }

  getWorkQuestions(): ExamQuestion[] {
    return this.fallback.getWorkQuestions();
  }

  gradeAnswer(question: ExamQuestion, submittedAnswer: string): boolean {
    return this.fallback.gradeAnswer(question, submittedAnswer);
  }
}
