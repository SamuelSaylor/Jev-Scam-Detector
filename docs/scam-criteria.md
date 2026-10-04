# Scam assessment criteria

Version 0.3.0 uses a balanced assessment of transcript evidence. A single ordinary word such as money, bank, urgent, or code is not enough. Multiple supporting signs raise suspicion. A clearly dangerous request, such as disclosing a login code or moving savings to a supposed safe account, can be strong evidence on its own. Suspicion is not proof of fraud or verified caller identity.

## Research sources

The following Australian government Scamwatch guides were retrieved and read during implementation. These patterns also occur outside Australia, but jurisdiction-specific legal claims are not encoded as universal rules.

| Source | Guidance used |
| --- | --- |
| [Phone scams](https://www.scamwatch.gov.au/types-of-scams/phone-scams) | Unverified authority claims, threats, requests for security codes, money movement, software installation, and independent callback verification. |
| [Phishing scams](https://www.scamwatch.gov.au/types-of-scams/phishing-scams) | Trusted-organization impersonation, account-problem pretexts, urgency, private information requests, safe-account transfers, and friends/family emergency requests. |
| [Investment scams](https://www.scamwatch.gov.au/types-of-scams/investment-scams) | Guaranteed large returns, pressure to act, relationship-based investment lures, escalating deposits, and excuses that prevent withdrawals. |
| [Unexpected money scams](https://www.scamwatch.gov.au/types-of-scams/unexpected-money-scams) | Fees and taxes to unlock prizes, inheritances, rebates, grants, and promised funds. |
| [Account or identity takeover scams](https://www.scamwatch.gov.au/types-of-scams/account-or-identity-takeover-scams) | Unsolicited tech-support pretexts, remote access, installation requests, and account credentials. |
| [Help to spot and avoid scams](https://www.scamwatch.gov.au/stop-check-protect/help-to-spot-and-avoid-scams) | Believable stories, manipulation, follow-up recovery scams, and the distinction between deception and ordinary disappointing transactions. |

FTC and CISA pages were attempted but returned HTTP 403. They are not represented here as reviewed sources. The source guidance supports warning signs, not model accuracy, numerical thresholds, or a calibrated confidence estimate.

## Judgment structure

`src/jev_scam_detector/scam_criteria.py` owns ten warning signs and their counterexamples. Jev evaluates them in context rather than doing keyword matching.

| Indicator | Look for | Avoid confusing with |
| --- | --- | --- |
| Credentials | Requests to disclose passwords, PINs, login codes, financial or identity details. | Entering a code in an official app, programming code, safety advice, or refusing disclosure. |
| Payment | Protective transfers, new unverified payees, gift cards, crypto wallets, cash couriers, overpayment refunds. | Ordinary invoices or financial discussion. |
| Impersonation | Authority or relationship claims used to obtain money, secrets, or access. | A routine introduction, or proof that the identity really is fake. |
| Urgency | Threats or deadlines used to push a risky request. | An ordinary deadline or legitimate urgent concern. |
| Secrecy | Preventing independent verification, ignoring warnings, isolating the recipient. | Ordinary privacy. |
| Remote access | Device control or disabling security under an unsolicited support/refund pretext. | Clearly user-initiated, independently verified support. |
| Upfront fee | Paying to unlock prizes, promised money, jobs, loans, withdrawals, or recovery. | Ordinary disclosed service charges. |
| Reward | Unrealistic or guaranteed returns and unexpected prizes used as a lure. | Realistic employment/investment discussion or warnings about such promises. |
| Story change | The same speaker changes an identity or explanation to keep a risky request alive. | Transparent corrections or another speaker disagreeing. |
| Persistence | The same speaker repeats or escalates a risky request after doubt or refusal. | Duplicate transcripts, normal repetition, or the recipient refusing. |

Story change and persistence are conversation-level interpretation rules added to meet the product requirement. They are not independent proof of fraud. Host and guest roles do not identify a scammer. A refusal does not erase an earlier request. Credible context may lower suspicion; unrelated later chatter should not automatically erase evidence.

The full retained transcript is assessed rather than only the most recent 20 lines. The room limit is still 256 segments. Large inputs can exceed Jev's context or response-time limits. Such failures leave the last successful result visible with a warning, and retry on the next tick. No transcript is silently summarized or discarded to fit a model limit.

## Suspicion and confidence

Live mode uses an ordered `Score` rubric for low, moderate, and high suspicion. Its probability-weighted score is divided by 2 and stored in the historical `risk` field. This is a normalized suspicion score, not a calibrated chance of fraud.

The display bands are low below 0.35, moderate from 0.35 to below 0.7, and high from 0.7. These defaults require evaluation on representative labeled conversations. They do not authorize any action.

Jev's `Score.confidence` is displayed as judgment confidence. It describes concentration of the model's distribution over rubric levels. A confident low-suspicion result can have a high confidence percentage. It does not establish truth. See the current [TypeSafe confidence documentation](https://docs.typesafe.ai/confidence.md).

Warning-sign and evidence `Noul` probabilities use a provisional 0.7 inclusion threshold. Indicators are omitted from the live summary when no evidence line meets that threshold. If suspicion is elevated but no specific sign can be cited reliably, the summary says so instead of inventing a reason.

Demo mode uses deterministic request-pattern rules and scores of 0.1, 0.5, or 0.9. Its confidence is null because there is no Jev distribution. It shares indicator meanings and summary wording, but cannot reproduce Jev's semantic understanding, all paraphrases, or subtle benign explanations. Do not interpret a demo score as model confidence.

## Display and reconnect behavior

The latest successful assessment is an atomic score, confidence, level, evidence set, and summary. New messages retain it with an updating note. Failures retain it with a small warning. The first result is never fabricated. REST and WebSocket snapshots restore the assessment and its freshness on reconnect to an active room.

Summaries combine at most two supported warning-sign phrases into one sentence. Low suspicion has an explicit summary too. Scores and summaries do not persist beyond room expiry, room termination, or server restart.

## Verification limits

Automated fixtures cover dangerous requests, benign wording, safety advice, refusals, combined signals, repeated pressure, changed stories, retained older evidence, failures, recovery, and reconnects. Jev adapter tests use typed SDK responses without network calls. They verify the integration, not detection accuracy against a live model. Credentialed evaluations and measured live latency remain required before trusting the rubric in real calls.
