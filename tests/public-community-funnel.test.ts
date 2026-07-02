import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function read(path: string): string {
  return readFileSync(path, "utf8");
}

describe("NeonDiff public community funnel", () => {
  it("README is NeonDiff-first and routes users to setup, contribution, agent, security, and roadmap docs", () => {
    const readme = read("README.md");

    for (const required of [
      /^# NeonDiff/m,
      /local-first AI PR reviewer/i,
      /https:\/\/www\.neondiff\.com/i,
      /docs\/SETUP\.md/i,
      /CONTRIBUTING\.md/i,
      /AGENTS\.md/i,
      /SECURITY\.md/i,
      /CODE_OF_CONDUCT\.md/i,
      /public open-source repos.*free/i,
      /private.*commercial.*paid/i,
      /source-available beta/i,
      /GitHub App/i,
      /dry-run review/i,
      /electricsheephq\/evaos-code-review-bot\/issues\/103/i,
      /electricsheephq\/evaos-code-review-bot\/issues\/104/i,
      /electricsheephq\/evaos-code-review-bot\/issues\/107/i,
      /electricsheephq\/evaos-code-review-bot\/issues\/113/i
    ]) {
      expect(readme).toMatch(required);
    }

    for (const forbidden of [
      /OpenSource replacement/i,
      /MIT License/i,
      /CodeRabbit parity/i,
      /enterprise-ready/i,
      /production-ready/i,
      /public repo launched/i
    ]) {
      expect(readme).not.toMatch(forbidden);
    }
  });

  it("setup guide gives a first-run path without hiding safety prerequisites in operator runbooks", () => {
    const setup = read("docs/SETUP.md");

    for (const required of [
      /^# NeonDiff Setup/m,
      /Requirements/i,
      /GitHub App/i,
      /Contents: read/i,
      /Pull requests: read\/write/i,
      /provider/i,
      /license/i,
      /config/i,
      /dry-run/i,
      /daemon/i,
      /status --json/i,
      /Troubleshooting/i,
      /Do not run.*dry-run false/i
    ]) {
      expect(setup).toMatch(required);
    }

    expect(setup).not.toMatch(/BEGIN (RSA|OPENSSH|PRIVATE) KEY|ghp_|github_pat_|sk-[A-Za-z0-9]/);
  });

  it("CONTRIBUTING and AGENTS are useful to humans and coding agents", () => {
    const contributing = read("CONTRIBUTING.md");
    const agents = read("AGENTS.md");

    for (const required of [
      /^# Contributing/m,
      /Quick Links/i,
      /Issue Routing/i,
      /Before You Open A PR/i,
      /Agent-Authored Contributions/i,
      /Validation/i,
      /Evidence/i,
      /Review Threads/i,
      /Good First Contributions/i,
      /Safety Boundaries/i,
      /docs\/SETUP\.md/i,
      /AGENTS\.md/i,
      /SECURITY\.md/i,
      /CODE_OF_CONDUCT\.md/i,
      /Closes #<issue>/i,
      /secret/i,
      /dry-run/i
    ]) {
      expect(contributing).toMatch(required);
    }

    for (const required of [
      /^# NeonDiff Agent Instructions/m,
      /Repository Agent Quick Start/i,
      /Read README\.md/i,
      /Read CONTRIBUTING\.md/i,
      /Read docs\/SETUP\.md/i,
      /Create or reuse a GitHub issue/i,
      /Write or update a failing test/i,
      /Do not commit.*tokens/i,
      /Do not restart launchd/i,
      /source-available/i,
      /Update the issue before handoff/i
    ]) {
      expect(agents).toMatch(required);
    }
  });

  it("GitHub issue and PR templates exist and require public-safe evidence", () => {
    for (const path of [
      "CODE_OF_CONDUCT.md",
      "SECURITY.md",
      "CONTRIBUTING.md",
      "AGENTS.md",
      ".github/PULL_REQUEST_TEMPLATE.md",
      ".github/ISSUE_TEMPLATE/config.yml",
      ".github/ISSUE_TEMPLATE/bug_report.yml",
      ".github/ISSUE_TEMPLATE/docs_bug_report.yml",
      ".github/ISSUE_TEMPLATE/feature_request.yml",
      ".github/ISSUE_TEMPLATE/provider_request.yml",
      ".github/ISSUE_TEMPLATE/license_setup_confusion.yml",
      ".github/ISSUE_TEMPLATE/unsafe_review_report.yml"
    ]) {
      expect(existsSync(path), `${path} must exist`).toBe(true);
    }

    const forms = [
      read(".github/ISSUE_TEMPLATE/bug_report.yml"),
      read(".github/ISSUE_TEMPLATE/docs_bug_report.yml"),
      read(".github/ISSUE_TEMPLATE/feature_request.yml"),
      read(".github/ISSUE_TEMPLATE/provider_request.yml"),
      read(".github/ISSUE_TEMPLATE/license_setup_confusion.yml"),
      read(".github/ISSUE_TEMPLATE/unsafe_review_report.yml")
    ];

    for (const form of forms) {
      expect(form).toMatch(/body:/);
      expect(form).toMatch(/validations:\n\s+required: true/);
      expect(form).toMatch(/public-safe|redacted|secret|token|credential/i);
    }

    const pr = read(".github/PULL_REQUEST_TEMPLATE.md");
    for (const required of [
      /What Problem This Solves/i,
      /User Impact/i,
      /Validation/i,
      /Safety Boundary/i,
      /Evidence/i,
      /Closes #<issue>/i,
      /agent-authored/i,
      /live worker/i
    ]) {
      expect(pr).toMatch(required);
    }
  });

  it("public readiness scorecard records proof boundary and launch limits", () => {
    const scorecardPath = "evals/scorecards/v1.0/public-community-readiness-review.json";
    expect(existsSync(scorecardPath), `${scorecardPath} must exist`).toBe(true);
    const scorecard = JSON.parse(read(scorecardPath)) as {
      current_score?: string;
      surface?: string;
      pass_criteria?: string[];
      proof_boundary?: string;
    };

    expect(scorecard.current_score).toBe("pass");
    expect(scorecard.surface).toBe("NeonDiff source-available beta repository");
    expect(JSON.stringify(scorecard.pass_criteria)).toMatch(/README/i);
    expect(JSON.stringify(scorecard.pass_criteria)).toMatch(/CONTRIBUTING/i);
    expect(JSON.stringify(scorecard.pass_criteria)).toMatch(/AGENTS/i);
    expect(JSON.stringify(scorecard.pass_criteria)).toMatch(/issue templates/i);
    expect(String(scorecard.proof_boundary)).toMatch(/does not prove public launch/i);
  });
});
