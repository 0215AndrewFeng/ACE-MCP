import { existsSync } from "node:fs";
import { basename } from "node:path";
import { performance } from "node:perf_hooks";

import {
  MAX_QUERY_LENGTH,
  type ProjectRouteCandidate,
  type ProjectRouteEvidence,
  type ProjectRouteMatch,
  type ProjectRouteResolution,
  type QueryAnalysis,
} from "../common/types.js";
import type { SQLiteStore } from "../storage/sqliteStore.js";
import { findAggregateProjectRoots } from "../project/projectHierarchy.js";
import { analyzeQuery, boundProjectRouteTerms } from "./queryAnalyzer.js";
import { ProjectSummaryRouteCatalog } from "./projectSummaryRouteCatalog.js";
import type { SearchService } from "./searchService.js";
import { CJK_PATTERN } from "./semanticText.js";

const DEFAULT_TOP_K = 3;
const MAX_TOP_K = 10;
const MIN_DECISION_CANDIDATES = 2;
const ROUTE_FANOUT_PER_PROJECT = 20;
const MAX_EVIDENCE_PER_PROJECT = 5;
const LEXICAL_EVIDENCE_WEIGHT = 0.15;
const SUMMARY_EVIDENCE_WEIGHT = 0.3;
const SYMBOL_EVIDENCE_WEIGHT = 0.45;
const DUPLICATE_EVIDENCE_DECAY = 0.1;
const SINGLE_PROJECT_MARGIN_RATIO = 0.25;
const MIN_SINGLE_PROJECT_SCORE = 0.6;
const FULL_CONFIDENCE_SCORE = 1.2;
const EXACT_MIXED_CONCEPT_WEIGHT = 0.3;
const PROJECT_NAME_ANCHOR_WEIGHT = 0.45;
const PROJECT_FAMILY_WEIGHT = 0.55;
const MIN_PROJECT_FAMILY_BASE_SCORE = 0.4;
const GENERIC_PROJECT_NAME_SEGMENTS = new Set([
  "admin",
  "api",
  "app",
  "backend",
  "client",
  "common",
  "core",
  "flight",
  "gateway",
  "java",
  "server",
  "service",
]);
const WEAK_ROUTE_TERMS = new Set([
  "api",
  "class",
  "controller",
  "error",
  "function",
  "handler",
  "interface",
  "manager",
  "method",
  "query",
  "service",
  "timeout",
  "处理",
  "控制器",
  "接口",
  "方法",
  "服务",
  "查询",
  "管理器",
  "超时",
  "错误",
  "异常",
]);

export interface ProjectRouteOptions {
  topK?: number;
}

export interface ProjectRoutingCaseInput {
  expectedDecision: ProjectRouteResolution["decision"];
  expectedProjects: string[];
  name: string;
  query: string;
}

export interface ProjectRoutingCaseResult extends ProjectRoutingCaseInput {
  actualDecision: ProjectRouteResolution["decision"];
  actualProjects: string[];
  candidateProjects: string[];
  firstRelevantRank?: number;
  passed: boolean;
}

export interface ProjectRoutingEvaluation {
  cases: ProjectRoutingCaseResult[];
  summary: {
    decisionAccuracy: number;
    meanReciprocalRank: number;
    recallAt3: number;
    top1Accuracy: number;
    total: number;
  };
}

interface CandidateAccumulator {
  evidence: ProjectRouteEvidence[];
  matchedTerms: Set<string>;
  projectRootPath: string;
  seenEvidence: Set<string>;
  sources: Set<ProjectRouteMatch["source"]>;
}

interface CandidateScoreDetails {
  baseScore: number;
  candidate: ProjectRouteCandidate;
  exactMixedCoverage: number;
  matchedProjectNameTerms: string[];
  projectNameSegments: string[];
}

function roundScore(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

function matchedTerms(match: ProjectRouteMatch, tokens: string[]): string[] {
  if (match.matchedTerms) {
    const actualMatches = new Set(match.matchedTerms);
    return tokens.filter((token) => actualMatches.has(token));
  }
  const normalized = match.matchText.normalize("NFKC").toLowerCase();
  return tokens.filter((token) => normalized.includes(token));
}

function scoreToConfidence(score: number): number {
  return roundScore(Math.min(1, Math.max(0, score / FULL_CONFIDENCE_SCORE)));
}

function scoreProjectEvidence(evidence: ProjectRouteEvidence[]): number {
  // Corpus-wide ranks let duplicate-heavy projects suppress equally strong smaller projects.
  const weights = evidence
    .map((item) => item.source === "symbol"
      ? SYMBOL_EVIDENCE_WEIGHT
      : item.source === "summary"
        ? SUMMARY_EVIDENCE_WEIGHT
        : LEXICAL_EVIDENCE_WEIGHT)
    .sort((left, right) => right - left);

  return weights.reduce(
    (score, weight, index) => score + weight * (index === 0 ? 1 : DUPLICATE_EVIDENCE_DECAY / index),
    0,
  );
}

function hasNonWeakRouteText(query: string): boolean {
  let remaining = query.normalize("NFKC").toLowerCase();
  for (const term of [...WEAK_ROUTE_TERMS].sort((left, right) => right.length - left.length)) {
    remaining = remaining.replaceAll(term, " ");
  }
  return /[\p{L}\p{N}_$]/u.test(remaining);
}

function isCoveredCjkConcept(concept: string, matchedRouteTerms: Set<string>): boolean {
  const conceptCharacters = [...concept];
  if (!conceptCharacters.every((character) => CJK_PATTERN.test(character))) {
    return false;
  }

  const matchedGrams = [...matchedRouteTerms]
    .filter((term) => {
      const characters = [...term];
      return characters.length === 2
        && characters.every((character) => CJK_PATTERN.test(character))
        && concept.includes(term);
    });
  const requiredCoverage = conceptCharacters.length - (conceptCharacters.length % 2);
  if (matchedGrams.length < 2 || matchedGrams.length * 2 < requiredCoverage) {
    return false;
  }

  const gramIndexes = new Map(matchedGrams.map((gram, index) => [gram, index]));
  const memo = new Map<string, number>();
  const maxSelectedGrams = (position: number, usedGrams: bigint, hasStrongGram: boolean): number => {
    if (position >= conceptCharacters.length - 1) {
      return hasStrongGram ? 0 : Number.NEGATIVE_INFINITY;
    }
    const key = `${position}:${usedGrams}:${hasStrongGram}`;
    const cached = memo.get(key);
    if (cached !== undefined) {
      return cached;
    }

    let selected = maxSelectedGrams(position + 1, usedGrams, hasStrongGram);
    const gram = conceptCharacters.slice(position, position + 2).join("");
    const gramIndex = gramIndexes.get(gram);
    if (gramIndex !== undefined) {
      const gramBit = 1n << BigInt(gramIndex);
      if ((usedGrams & gramBit) === 0n) {
        selected = Math.max(
          selected,
          1 + maxSelectedGrams(position + 2, usedGrams | gramBit, hasStrongGram || hasNonWeakRouteText(gram)),
        );
      }
    }
    memo.set(key, selected);
    return selected;
  };

  const selectedGrams = maxSelectedGrams(0, 0n, false);
  return selectedGrams >= 2 && selectedGrams * 2 >= requiredCoverage;
}

function routeConceptCoverage(
  routeConcepts: string[],
  matchedRouteTerms: Set<string>,
): number {
  if (routeConcepts.length === 0) {
    return 0;
  }
  const coveredConcepts = routeConcepts.filter(
    (concept) => matchedRouteTerms.has(concept) || isCoveredCjkConcept(concept, matchedRouteTerms),
  ).length;
  return coveredConcepts / routeConcepts.length;
}

function exactMixedConceptCoverage(
  routeConcepts: string[],
  matchedRouteTerms: Set<string>,
): number {
  const mixedConcepts = routeConcepts.filter(
    (concept) => /[a-z0-9]/i.test(concept) && CJK_PATTERN.test(concept),
  );
  if (mixedConcepts.length === 0) {
    return 0;
  }

  return mixedConcepts.filter((concept) => matchedRouteTerms.has(concept)).length / mixedConcepts.length;
}

function projectNameSegments(projectRootPath: string): string[] {
  return [...new Set(basename(projectRootPath)
    .normalize("NFKC")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((segment) => segment.length >= 3 && !GENERIC_PROJECT_NAME_SEGMENTS.has(segment)))];
}

function hasStrongRouteSignal(query: string, analysis: QueryAnalysis): boolean {
  if (analysis.identifiers.length > 0) {
    return true;
  }

  return hasNonWeakRouteText(query);
}

export class ProjectRouter {
  private readonly summaryCatalog = new ProjectSummaryRouteCatalog();

  public constructor(
    private readonly store: SQLiteStore,
    private readonly searchService: SearchService,
  ) {}

  public async resolve(query: string, options: ProjectRouteOptions = {}): Promise<ProjectRouteResolution> {
    const startedAt = performance.now();
    const normalizedQuery = query.normalize("NFKC").trim().slice(0, MAX_QUERY_LENGTH);
    const topK = Math.max(MIN_DECISION_CANDIDATES, Math.min(options.topK ?? DEFAULT_TOP_K, MAX_TOP_K));
    if (!normalizedQuery) {
      return this.buildResolution(normalizedQuery, [], "abstain", [], startedAt);
    }

    const analysis = analyzeQuery(normalizedQuery);
    const routeTerms = boundProjectRouteTerms(analysis.tokens);
    const routeConcepts = boundProjectRouteTerms(
      analysis.identifiers.length > 0 && analysis.hasIdentifierLikeSegments && !analysis.isPathLike
        ? analysis.identifiers
        : [...analysis.identifiers, ...analysis.naturalLanguage],
    );
    const projectNameQueryTerms = new Set(boundProjectRouteTerms([
      ...routeTerms,
      ...analysis.semanticTerms,
    ]));
    if (!hasStrongRouteSignal(normalizedQuery, analysis)) {
      return this.buildResolution(normalizedQuery, [], "abstain", [], startedAt);
    }

    const registeredProjects = this.store.listProjects();
    const aggregateRoots = findAggregateProjectRoots(registeredProjects.map((project) => project.projectRootPath));
    const eligibleProjects = registeredProjects.filter(
      (project) => project.status === "ready" && existsSync(project.projectRootPath) && !aggregateRoots.has(project.projectRootPath),
    );
    const eligibleRoots = new Set(eligibleProjects.map((project) => project.projectRootPath));
    const excludedProjectRootPaths = registeredProjects
      .map((project) => project.projectRootPath)
      .filter((projectRootPath) => !eligibleRoots.has(projectRootPath));
    const [codeMatches, summaryMatches] = await Promise.all([
      this.searchService.searchProjectRouteMatches(
        normalizedQuery,
        Math.max(50, Math.min(500, eligibleProjects.length * ROUTE_FANOUT_PER_PROJECT)),
        excludedProjectRootPaths,
      ),
      this.summaryCatalog.findMatches([...eligibleRoots], routeTerms),
    ]);
    const matches = [...summaryMatches, ...codeMatches];
    const accumulators = new Map<string, CandidateAccumulator>();

    for (const match of matches) {
      if (!eligibleRoots.has(match.projectRootPath)) {
        continue;
      }
      const accumulator = accumulators.get(match.projectRootPath) ?? {
        evidence: [],
        matchedTerms: new Set<string>(),
        projectRootPath: match.projectRootPath,
        seenEvidence: new Set<string>(),
        sources: new Set<ProjectRouteMatch["source"]>(),
      };
      const terms = matchedTerms(match, routeTerms);
      for (const term of terms) {
        accumulator.matchedTerms.add(term);
      }

      const evidenceKey = `${match.source}:${match.filePath}:${match.symbol ?? ""}`;
      if (!accumulator.seenEvidence.has(evidenceKey)) {
        accumulator.seenEvidence.add(evidenceKey);
        accumulator.sources.add(match.source);
        if (accumulator.evidence.length < MAX_EVIDENCE_PER_PROJECT) {
          accumulator.evidence.push({
            filePath: match.filePath,
            matchedTerms: terms,
            source: match.source,
            symbol: match.symbol,
          });
        }
      }
      accumulators.set(match.projectRootPath, accumulator);
    }

    const scoredCandidates: CandidateScoreDetails[] = [...accumulators.values()]
      .map((item) => {
        const tokenCoverage = routeConceptCoverage(routeConcepts, item.matchedTerms);
        const mixedConceptCoverage = exactMixedConceptCoverage(routeConcepts, item.matchedTerms);
        const sourceDiversity = item.sources.size;
        const baseScore = scoreProjectEvidence(item.evidence)
          + tokenCoverage * 0.45
          + mixedConceptCoverage * EXACT_MIXED_CONCEPT_WEIGHT
          + Math.max(0, sourceDiversity - 1) * 0.15;
        const nameSegments = projectNameSegments(item.projectRootPath);
        const matchedProjectNameTerms = nameSegments.filter((segment) => projectNameQueryTerms.has(segment));
        return {
          baseScore,
          candidate: {
            confidence: scoreToConfidence(baseScore),
            evidence: item.evidence,
            matchedTerms: [...item.matchedTerms],
            projectRootPath: item.projectRootPath,
            score: roundScore(baseScore),
          },
          exactMixedCoverage: mixedConceptCoverage,
          matchedProjectNameTerms,
          projectNameSegments: nameSegments,
        };
      });

    const ownershipAnchor = scoredCandidates
      .filter((item) => item.exactMixedCoverage > 0 && item.matchedProjectNameTerms.length > 0)
      .sort((left, right) =>
        right.baseScore - left.baseScore
        || left.candidate.projectRootPath.localeCompare(right.candidate.projectRootPath))[0];
    const ownershipFamilySegments = new Set(
      ownershipAnchor?.projectNameSegments.filter(
        (segment) => !ownershipAnchor.matchedProjectNameTerms.includes(segment),
      ) ?? [],
    );
    const ownershipProjectRootPaths = new Set<string>();

    for (const item of scoredCandidates) {
      let score = item.baseScore;
      if (item === ownershipAnchor) {
        score += PROJECT_NAME_ANCHOR_WEIGHT;
        ownershipProjectRootPaths.add(item.candidate.projectRootPath);
      } else if (
        ownershipFamilySegments.size > 0
        && item.baseScore >= MIN_PROJECT_FAMILY_BASE_SCORE
        && item.projectNameSegments.some((segment) => ownershipFamilySegments.has(segment))
      ) {
        score += PROJECT_FAMILY_WEIGHT;
        ownershipProjectRootPaths.add(item.candidate.projectRootPath);
      }
      item.candidate.score = roundScore(score);
      item.candidate.confidence = scoreToConfidence(score);
    }

    const candidates = scoredCandidates
      .map((item) => item.candidate)
      .sort((left, right) => right.score - left.score || left.projectRootPath.localeCompare(right.projectRootPath))
      .slice(0, topK);

    if (candidates.length === 0) {
      return this.buildResolution(normalizedQuery, [], "abstain", [], startedAt);
    }

    const top = candidates[0]!;
    const second = candidates[1];
    if (top.score < MIN_SINGLE_PROJECT_SCORE) {
      return this.buildResolution(normalizedQuery, candidates, "abstain", [], startedAt);
    }
    const ownedCandidates = candidates.filter(
      (candidate) => candidate.score >= MIN_SINGLE_PROJECT_SCORE
        && ownershipProjectRootPaths.has(candidate.projectRootPath),
    );
    if (ownedCandidates.length > 0) {
      return this.buildResolution(
        normalizedQuery,
        candidates,
        ownedCandidates.length === 1 ? "single" : "multiple",
        ownedCandidates.map((candidate) => candidate.projectRootPath),
        startedAt,
      );
    }
    if (!second || (top.score - second.score) / Math.max(top.score, Number.EPSILON) >= SINGLE_PROJECT_MARGIN_RATIO) {
      return this.buildResolution(normalizedQuery, candidates, "single", [top.projectRootPath], startedAt);
    }

    const selectedProjectRootPaths = candidates
      .filter((candidate) => candidate.score >= top.score * (1 - SINGLE_PROJECT_MARGIN_RATIO))
      .map((candidate) => candidate.projectRootPath);
    return this.buildResolution(normalizedQuery, candidates, "multiple", selectedProjectRootPaths, startedAt);
  }

  public async evaluate(cases: ProjectRoutingCaseInput[]): Promise<ProjectRoutingEvaluation> {
    const results: ProjectRoutingCaseResult[] = [];
    for (const input of cases) {
      const resolution = await this.resolve(input.query, { topK: 3 });
      const expectedProjects = new Set(input.expectedProjects);
      const actualProjects = resolution.selectedProjectRootPaths;
      const candidateProjects = resolution.candidates.map((candidate) => candidate.projectRootPath);
      const firstRelevantIndex = candidateProjects.findIndex((projectRootPath) => expectedProjects.has(projectRootPath));
      const firstRelevantRank = firstRelevantIndex >= 0 ? firstRelevantIndex + 1 : undefined;
      const projectMatch = input.expectedProjects.length === 0
        ? actualProjects.length === 0
        : input.expectedProjects.length === actualProjects.length
          && input.expectedProjects.every((projectRootPath) => actualProjects.includes(projectRootPath));
      results.push({
        ...input,
        actualDecision: resolution.decision,
        actualProjects,
        candidateProjects,
        firstRelevantRank,
        passed: resolution.decision === input.expectedDecision && projectMatch,
      });
    }

    const projectCases = results.filter((result) => result.expectedProjects.length > 0);
    const decisionAccuracy = results.length > 0
      ? results.filter((result) => result.actualDecision === result.expectedDecision).length / results.length
      : 1;
    const top1Accuracy = projectCases.length > 0
      ? projectCases.filter((result) => result.firstRelevantRank === 1).length / projectCases.length
      : 1;
    const recallAt3 = projectCases.length > 0
      ? projectCases.reduce((total, result) => {
          const topThree = new Set(result.candidateProjects.slice(0, 3));
          const recalled = result.expectedProjects.filter((projectRootPath) => topThree.has(projectRootPath)).length;
          return total + recalled / result.expectedProjects.length;
        }, 0) / projectCases.length
      : 1;
    const meanReciprocalRank = projectCases.length > 0
      ? projectCases.reduce((total, result) => total + (result.firstRelevantRank ? 1 / result.firstRelevantRank : 0), 0) / projectCases.length
      : 1;

    return {
      cases: results,
      summary: {
        decisionAccuracy: roundScore(decisionAccuracy),
        meanReciprocalRank: roundScore(meanReciprocalRank),
        recallAt3: roundScore(recallAt3),
        top1Accuracy: roundScore(top1Accuracy),
        total: results.length,
      },
    };
  }

  private buildResolution(
    query: string,
    candidates: ProjectRouteCandidate[],
    decision: ProjectRouteResolution["decision"],
    selectedProjectRootPaths: string[],
    startedAt: number,
  ): ProjectRouteResolution {
    return {
      candidates,
      decision,
      durationMs: Math.round(performance.now() - startedAt),
      query,
      selectedProjectRootPaths,
    };
  }
}
