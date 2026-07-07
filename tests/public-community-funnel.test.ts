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
      /docs\/SETUP\.md/i,
      /docs\/github-app-setup\.md/i,
      /CONTRIBUTING\.md/i,
      /AGENTS\.md/i,
      /SECURITY\.md/i,
      /CODE_OF_CONDUCT\.md/i,
      /LICENSE\.md/i,
      /docs\/license-boundary\.md/i,
      /docs\/pricing\.md/i,
      /docs\/providers\.md/i,
      /docs\/known-limitations-and-provider-status\.md/i,
      /public open-source repos.*free/i,
      /\$1\/month/i,
      /\$10\/year/i,
      /\$100\/year/i,
      /7-day trial/i,
      /30-day trial/i,
      /legacy lifetime licenses remain honored/i,
      /private.*commercial.*paid/i,
      /source-available beta/i,
      /GitHub App/i,
      /dry-run review/i,
      /electricsheephq\/evaos-code-review-bot-neondiff\/issues\/103/i,
      /electricsheephq\/evaos-code-review-bot-neondiff\/issues\/104/i,
      /electricsheephq\/evaos-code-review-bot-neondiff\/issues\/105/i,
      /electricsheephq\/evaos-code-review-bot-neondiff\/issues\/107/i,
      /electricsheephq\/evaos-code-review-bot-neondiff\/issues\/113/i
    ]) {
      expect(readme).toMatch(required);
    }
    expect(readme).toContain("https://www.neondiff.com");

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

  it("license boundary surfaces are canonical and avoid open-source claims", () => {
    const license = read("LICENSE.md");
    const boundary = read("docs/license-boundary.md");
    const pkg = JSON.parse(read("package.json")) as { license?: string };

    expect(pkg.license).toBe("SEE LICENSE IN LICENSE.md");

    for (const text of [license, boundary]) {
      expect(text).toMatch(/source-available beta/i);
      expect(text).toMatch(/Public open-source repositor(?:y|ies).*free/i);
      expect(text).toMatch(/private/i);
      expect(text).toMatch(/commercial/i);
      expect(text).toMatch(/paid NeonDiff license/i);
      expect(text).toMatch(/Third-party/i);
      expect(text).toMatch(/own licenses/i);
      expect(text).not.toMatch(/^# MIT License/im);
      expect(text).not.toMatch(/^# Apache License/im);
      expect(text).not.toMatch(/OSI-approved/i);
    }

    expect(boundary).toMatch(/copy these claims/i);
    expect(boundary).toMatch(/Do not describe NeonDiff as \"open source\"|Avoid:\n\n- \"open source\"/i);
  });

  it("pricing doc records support tiers, BYOK costs, and no hosted model credit bundle", () => {
    const pricing = read("docs/pricing.md");
    const setup = read("docs/SETUP.md");
    const boundary = read("docs/license-boundary.md");
    const issueTemplate = read(".github/ISSUE_TEMPLATE/license_setup_confusion.yml");

    for (const text of [pricing, setup, boundary]) {
      expect(text).toMatch(/public open-source/i);
      expect(text).toMatch(/\$1\/mo|\$1\/month/i);
      expect(text).toMatch(/\$10\/yr|\$10\/year/i);
      expect(text).toMatch(/\$100\/yr|\$100\/year/i);
      expect(text).toMatch(/7-day.*trial/i);
      expect(text).toMatch(/30-day.*trial/i);
      expect(text).toMatch(/legacy lifetime licenses? remain honored/i);
      expect(text).toMatch(/private repo review|private.*repo/i);
      expect(text).toMatch(/commercial/i);
      expect(text).toMatch(/auto-updates/i);
      expect(text).toMatch(/BYOK|provider key|local model/i);
      const normalized = text.replace(/\s+/g, " ");
      expect(normalized).toMatch(/hosted model credits/i);
      expect(normalized).toMatch(/does not include|do not include|not included|no bundled/i);
      expect(text).not.toMatch(/unlimited SaaS inference included|bundled provider tokens included/i);
    }

    expect(pricing).toMatch(/neondiff pricing/i);
    expect(pricing).toMatch(/monthly_support/i);
    expect(pricing).toMatch(/yearly_support/i);
    expect(pricing).toMatch(/org_yearly_support/i);
    expect(pricing).toMatch(/lifetime_support/i);
    expect(pricing).toMatch(/no longer sold/i);
    expect(issueTemplate).toMatch(/docs\/pricing\.md/i);
  });

  it("setup guide gives a first-run path without hiding safety prerequisites in operator runbooks", () => {
    const setup = read("docs/SETUP.md");
    const githubApp = read("docs/github-app-setup.md");
    const providers = read("docs/providers.md");

    for (const required of [
      /^# NeonDiff Setup/m,
      /Requirements/i,
      /GitHub App/i,
      /github-app-setup\.md/i,
      /Contents: read/i,
      /Pull requests: read\/write/i,
      /doctor github/i,
      /providers list/i,
      /providers doctor/i,
      /app_installation/i,
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
    expect(githubApp).toMatch(/^# GitHub App Install And Onboarding/m);
    expect(providers).toMatch(/^# NeonDiff Provider Registry/m);
    expect(providers).toMatch(/GLM\/Z\.ai/i);
    expect(providers).toMatch(/Ollama/i);
    expect(providers).toMatch(/OpenAI-compatible/i);
    expect(providers).toMatch(/apiKeyEnv/i);
    expect(providers).toMatch(/must not store the API key/i);
    expect(providers).toMatch(/proof boundary/i);
    expect(providers).not.toMatch(/BEGIN (RSA|OPENSSH|PRIVATE) KEY|ghp_|github_pat_|sk-[A-Za-z0-9]/);
    for (const required of [
      /Install URL/i,
      /Selected-Repo Install Path/i,
      /Only select repositories/i,
      /Repository Permissions/i,
      /Metadata: read/i,
      /Contents: read/i,
      /Pull requests: read\/write/i,
      /Checks: read/i,
      /Actions: read/i,
      /issue-enrichment permissions are separate from PR review/i,
      /issueEnrichment\.allowlist/i,
      /neondiff doctor github --config config\.local\.json --json/i,
      /activeRepoChecks/i,
      /First Review Path/i,
      /dry-run true/i,
      /App bot, not the human user token/i,
      /License Boundary/i,
      /Public open-source repositories are free/i,
      /Private and commercial repositories require/i,
      /Private repo data stays local/i,
      /Uninstall/i,
      /Troubleshooting/i,
      /Evidence To Save/i
    ]) {
      expect(githubApp).toMatch(required);
    }
    expect(githubApp).not.toMatch(/BEGIN (RSA|OPENSSH|PRIVATE) KEY|ghp_|github_pat_|sk-[A-Za-z0-9]/);
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
      /docs\/known-limitations-and-provider-status\.md/i,
      /docs\/triage-policy\.md/i,
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
      ".github/ISSUE_TEMPLATE/question.yml",
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
      read(".github/ISSUE_TEMPLATE/question.yml"),
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
      /Proof Boundary/i,
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

  it("launch-influx docs separate provider proof, triage, security, and support boundaries", () => {
    const limitations = read("docs/known-limitations-and-provider-status.md");
    const triage = read("docs/triage-policy.md");
    const providers = read("docs/providers.md");
    const security = read("SECURITY.md");

    for (const text of [limitations, providers]) {
      expect(text).toMatch(/tested by NeonDiff/i);
      expect(text).toMatch(/compatible by interface/i);
      expect(text).toMatch(/resource only/i);
      expect(text).toMatch(/GLM\/Z\.AI|GLM\/Z\.ai/i);
      expect(text).toMatch(/Ollama/i);
      expect(text).toMatch(/Hosted OpenAI-compatible BYOK/i);
    }

    for (const text of [limitations, triage, security]) {
      expect(text).toMatch(/support@electricsheephq\.com/i);
      expect(text).toMatch(/owner.*verify|requires owner verification|owner must verify/i);
      expect(text).toMatch(/private.*security|security.*private/i);
      expect(text).not.toMatch(/support@electricsheephq\.com.*verified/i);
    }

    expect(limitations).toMatch(/Pinned discussion title/i);
    expect(limitations).toMatch(/does not pin GitHub UI state/i);
    expect(limitations).toMatch(/macOS/i);
    expect(limitations).toMatch(/Linux/i);
    expect(triage).toMatch(/Agent-Driven Triage Behavior/i);
    expect(triage).toMatch(/Response-Time Intent/i);
    expect(triage).toMatch(/ga-blocker/i);
    expect(triage).toMatch(/owner-gated/i);
  });
});
