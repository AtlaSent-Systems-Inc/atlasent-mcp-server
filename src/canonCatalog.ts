// GENERATED-DERIVED — do not edit directly.
// Source: atlasent/generated/act-spec-index.json (from contract/canonical-actions/ACT-*.yaml)
// Updated by: python3 scripts/generate-from-canon.py in the atlasent repo.

export interface ActSpecGateFlags {
  requires_human_approval: boolean;
  requires_mfa: boolean;
  requires_verified_actor: boolean;
  requires_state_snapshot: boolean;
  required_assertion_classes: string[];
}

export interface ActSpecAuthorizationPattern {
  type: string;
  machine_executable: boolean;
  minimum_approvals?: number;
}

export interface ActSpecEntry {
  id: string;
  slug: string;
  display_name: string;
  description: string;
  family: string;
  risk_posture: string;
  ai_risk: string;
  gate_flags: ActSpecGateFlags;
  authorization_pattern: ActSpecAuthorizationPattern;
  regulatory_mappings: Record<string, unknown>[];
  evidence_requirements: Record<string, unknown>;
  use_case: string;
  industries: string[];
}

export const CANON_ACT_CATALOG: ActSpecEntry[] = [
  {
    id: "ACT-0001",
    slug: "production.deploy",
    display_name: "Production Deploy",
    description: `Authorization gate for deploying code, configuration, or infrastructure to a production environment. Production deployments carry high blast radius — an unauthorized or insufficiently-reviewed change can cause outages, data corruption, or security exposure across all customers. Every deploy must be traceable to a tamper-evident permit with an auditable approval chain.`,
    family: "production.deploy",
    risk_posture: "high",
    ai_risk: "High",
    gate_flags: {
      requires_human_approval: true,
      requires_mfa: false,
      requires_verified_actor: false,
      requires_state_snapshot: true,
      required_assertion_classes: [],
    },
    authorization_pattern: {
      type: "four-eyes",
      machine_executable: false,
      minimum_approvals: 2,
    },
    regulatory_mappings: [
        {
            "framework": "sox",
            "clause": "SOX §404 — Management Assessment of Internal Controls",
            "mapping": "AtlaSent captures a tamper-evident permit for every production deployment, proving change control gates ran with named approvers, timestamps, and audit-chain linkage. Satisfies PCAOB AS 2201 change management evidence requirements.\n",
            "evidence_source": "audit_chain",
            "status_query": "deployment_change_control_pct"
        },
        {
            "framework": "iso27001",
            "clause": "ISO/IEC 27001:2022 A.8.32 — Change Management",
            "mapping": "Deployment permits provide the documented authorization record ISO 27001 requires before changes reach production systems.\n",
            "evidence_source": "permit_record",
            "status_query": "change_management_permit_coverage"
        },
        {
            "framework": "nist_800_53",
            "clause": "NIST SP 800-53 Rev.5 CM-3 — Configuration Change Control",
            "mapping": "AtlaSent enforces the approval, documentation, and audit requirements of CM-3 at deploy time rather than as a post-hoc review.\n",
            "evidence_source": "audit_chain",
            "status_query": "cm3_deploy_gate_pct"
        }
    ],
    evidence_requirements: {
        "minimum_pattern": "EP-02",
        "approval_artifact_required": true,
        "state_snapshot_required": true,
        "notes": "State snapshot captures the git SHA, image digest, or Terraform plan hash at authorization time, binding the permit to the exact artifact deployed.\n"
    },
    use_case: `Gate every production deployment behind a tamper-evident permit with named approvers, change window enforcement, and an offline-verifiable audit chain — so auditors can prove who authorized what, when, and with what evidence.`,
    industries: ["fintech", "healthtech", "saas", "enterprise", "regulated-industries"],
  },
  {
    id: "ACT-0002",
    slug: "artifact.release",
    display_name: "Artifact Release",
    description: `Authorization gate for publishing a versioned artifact to a public or private distribution channel — npm, PyPI, crates.io, Docker Hub, Maven Central, GitHub Releases, or any package registry. Once published, an artifact is consumed by downstream systems; a malicious or compromised release propagates silently through the supply chain. Requires cryptographically verified actor identity to close the spoofed-actor attack surface.`,
    family: "production.deploy",
    risk_posture: "high",
    ai_risk: "High",
    gate_flags: {
      requires_human_approval: false,
      requires_mfa: false,
      requires_verified_actor: true,
      requires_state_snapshot: true,
      required_assertion_classes: ["supply_chain"],
    },
    authorization_pattern: {
      type: "role-only",
      machine_executable: true,
    },
    regulatory_mappings: [
        {
            "framework": "nist_800_53",
            "clause": "NIST SP 800-53 Rev.5 SA-12 — Supply Chain Protection",
            "mapping": "AtlaSent permits for artifact releases provide the documented authorization chain NIST SA-12 requires for software components entering the supply chain.\n",
            "evidence_source": "permit_record",
            "status_query": "artifact_release_permit_coverage"
        },
        {
            "framework": "eu_ai_act",
            "clause": "EU AI Act Art. 18 — Technical Documentation",
            "mapping": "For AI system components, release permits create the documented deployment authorization trail required for EU AI Act conformance assessments.\n",
            "evidence_source": "audit_chain",
            "status_query": "ai_artifact_release_documentation_pct"
        }
    ],
    evidence_requirements: {
        "minimum_pattern": "EP-02",
        "approval_artifact_required": false,
        "state_snapshot_required": true,
        "required_assertions": [
            "supply_chain"
        ],
        "notes": "State snapshot should include the artifact content hash and the registry destination. The supply_chain assertion provides SLSA-level provenance.\n"
    },
    use_case: `Prevent unauthorized or compromised actors from publishing packages to npm, PyPI, crates.io, or any registry. Every release is gated behind a cryptographically verified actor identity and a supply chain assertion binding the artifact hash.`,
    industries: ["saas", "developer-tools", "fintech", "enterprise", "open-source"],
  },
  {
    id: "ACT-0003",
    slug: "workflow.approve",
    display_name: "Workflow Approval",
    description: `Authorization gate for recording a human approval decision within a multi-step workflow. An approval is definitionally a human act — it attests that a qualified person reviewed content and authorizes progression. Machine-generated approvals are not approvals; they are automated checks. This action requires a human actor to prevent AI systems from self-approving workflow steps they participate in — the AI self-approval loop that regulators are now mandating controls for.`,
    family: "production.deploy",
    risk_posture: "standard",
    ai_risk: "Extreme",
    gate_flags: {
      requires_human_approval: true,
      requires_mfa: false,
      requires_verified_actor: false,
      requires_state_snapshot: false,
      required_assertion_classes: [],
    },
    authorization_pattern: {
      type: "role-only",
      machine_executable: false,
    },
    regulatory_mappings: [
        {
            "framework": "sox",
            "clause": "SOX §302 — Corporate Responsibility for Financial Reports",
            "mapping": "Financial reporting approvals require a human officer. AtlaSent records the approval actor, timestamp, and permit chain proving a human (not an automated system) authorized the progression.\n",
            "evidence_source": "audit_chain",
            "status_query": "workflow_approval_human_pct"
        },
        {
            "framework": "gdpr",
            "clause": "GDPR Art. 22 — Automated Individual Decision-Making",
            "mapping": "For workflows affecting data subjects, human approval gates provide the meaningful human involvement GDPR Art. 22 requires when significant decisions involve automated processing.\n",
            "evidence_source": "evaluation_record",
            "status_query": "gdpr_human_approval_coverage"
        }
    ],
    evidence_requirements: {
        "minimum_pattern": "EP-01",
        "approval_artifact_required": true,
        "state_snapshot_required": false
    },
    use_case: `Prevent AI agents from approving their own outputs or advancing workflows they participate in. Every workflow approval is gated to verified human actors — closing the AI self-approval loop that regulators are now requiring controls for.`,
    industries: ["fintech", "healthtech", "regulated-industries", "enterprise", "legal"],
  },
  {
    id: "ACT-0005",
    slug: "data.modify",
    display_name: "Data Modification",
    description: `Authorization gate for modifications to regulated, critical, or shared data. Data modifications have broad downstream effects — corrupted records in healthcare, financial, or compliance contexts can propagate silently and are difficult to reverse. State snapshot binding captures the pre-modification state, enabling rollback evidence and satisfying reason-for-change requirements under 21 CFR Part 11 §11.10(e).`,
    family: "data.access",
    risk_posture: "standard",
    ai_risk: "Medium",
    gate_flags: {
      requires_human_approval: false,
      requires_mfa: false,
      requires_verified_actor: false,
      requires_state_snapshot: true,
      required_assertion_classes: [],
    },
    authorization_pattern: {
      type: "role-only",
      machine_executable: true,
    },
    regulatory_mappings: [
        {
            "framework": "gdpr",
            "clause": "GDPR Art. 5(1)(d) — Accuracy Principle",
            "mapping": "AtlaSent records who modified data, when, and with what authorization, satisfying GDPR accountability requirements for data accuracy and auditability of changes.\n",
            "evidence_source": "audit_chain",
            "status_query": "data_modification_audit_coverage"
        },
        {
            "framework": "hipaa",
            "clause": "HIPAA §164.312(c)(1) — Integrity Controls",
            "mapping": "AtlaSent provides the access controls and audit trail HIPAA requires to protect electronic protected health information from improper alteration or destruction.\n",
            "evidence_source": "evaluation_record",
            "status_query": "phi_modification_gate_pct"
        },
        {
            "framework": "21cfr_part_11",
            "clause": "21 CFR Part 11 §11.10(e) — Audit Trails",
            "mapping": "AtlaSent captures the reason-for-change and actor identity for every data modification, satisfying FDA electronic records audit trail requirements.\n",
            "evidence_source": "audit_chain",
            "status_query": "cfr11_reason_for_change_pct"
        }
    ],
    evidence_requirements: {
        "minimum_pattern": "EP-01",
        "approval_artifact_required": false,
        "state_snapshot_required": true,
        "notes": "State snapshot should capture a hash of the record before modification. The reason field (21 CFR Part 11 §11.10(e)) should be included in the evaluate request context.\n"
    },
    use_case: `Gate all modifications to regulated data (PHI, financial records, clinical trial data) with actor attribution, state snapshots, and reason-for-change capture — satisfying FDA, HIPAA, and GDPR audit trail requirements.`,
    industries: ["healthtech", "fintech", "life-sciences", "regulated-industries"],
  },
  {
    id: "ACT-0007",
    slug: "data.import",
    display_name: "Data Import",
    description: `Authorization gate for ingesting external data into regulated or production systems — ETL pipelines, third-party data feeds, clinical trial data imports, financial data onboarding, and AI training data ingestion. Imported data can introduce corruption, malicious content, or unvalidated records into clean systems. State snapshot binding captures the source dataset hash, satisfying data provenance requirements under 21 CFR Part 11 and HIPAA.`,
    family: "data.access",
    risk_posture: "high",
    ai_risk: "High",
    gate_flags: {
      requires_human_approval: false,
      requires_mfa: false,
      requires_verified_actor: false,
      requires_state_snapshot: true,
      required_assertion_classes: [],
    },
    authorization_pattern: {
      type: "role-only",
      machine_executable: true,
    },
    regulatory_mappings: [
        {
            "framework": "hipaa",
            "clause": "HIPAA §164.308(a)(1) — Security Management Process",
            "mapping": "AtlaSent gates data imports from external sources, ensuring only authorized actors can introduce external data into systems containing ePHI.\n",
            "evidence_source": "evaluation_record",
            "status_query": "phi_import_gate_pct"
        },
        {
            "framework": "21cfr_part_11",
            "clause": "21 CFR Part 11 §11.10 — Controls for Closed Systems",
            "mapping": "AtlaSent ensures data imported into validated systems carries authorization evidence and a source hash binding the import to a specific dataset version.\n",
            "evidence_source": "audit_chain",
            "status_query": "cfr11_data_import_pct"
        },
        {
            "framework": "gdpr",
            "clause": "GDPR Art. 25 — Data Protection by Design and by Default",
            "mapping": "Authorization controls at import time implement data protection by design, preventing unauthorized or unvalidated data from entering systems that process personal data.\n",
            "evidence_source": "permit_record",
            "status_query": "gdpr_import_authorization_pct"
        }
    ],
    evidence_requirements: {
        "minimum_pattern": "EP-02",
        "approval_artifact_required": false,
        "state_snapshot_required": true,
        "notes": "State snapshot should include the source dataset hash and record count. For clinical data, include the CRF version or EDC export timestamp.\n"
    },
    use_case: `Gate all data imports from external sources — clinical trial data, financial feeds, third-party vendors — with integrity verification and authorization permits that prove what was imported, by whom, and from where.`,
    industries: ["healthtech", "life-sciences", "fintech", "enterprise"],
  },
  {
    id: "ACT-0008",
    slug: "data.delete",
    display_name: "Data Deletion",
    description: `Authorization gate for deletion of regulated, irreplaceable, or legally significant data. Deletions are irreversible in most systems; unauthorized deletion can result in permanent data loss, GDPR erasure obligation violations (proving deletion happened), and destruction of records required to be retained under SOX or HIPAA. State snapshot binding captures what existed at deletion time for erasure certificates and retention audits.`,
    family: "data.access",
    risk_posture: "high",
    ai_risk: "High",
    gate_flags: {
      requires_human_approval: false,
      requires_mfa: false,
      requires_verified_actor: false,
      requires_state_snapshot: true,
      required_assertion_classes: [],
    },
    authorization_pattern: {
      type: "role-only",
      machine_executable: true,
    },
    regulatory_mappings: [
        {
            "framework": "gdpr",
            "clause": "GDPR Art. 17 — Right to Erasure",
            "mapping": "AtlaSent records who authorized the deletion, when, and with what evidence — creating the documented erasure record GDPR Art. 17 requires to demonstrate compliance with erasure requests.\n",
            "evidence_source": "audit_chain",
            "status_query": "gdpr_erasure_documentation_pct"
        },
        {
            "framework": "hipaa",
            "clause": "HIPAA §164.530(j) — Retention Requirements",
            "mapping": "AtlaSent creates an immutable record of authorized deletions, enabling HIPAA-compliant demonstration that data was deleted as required or retained as mandated.\n",
            "evidence_source": "permit_record",
            "status_query": "phi_deletion_authorization_pct"
        },
        {
            "framework": "sox",
            "clause": "SOX §802 — Criminal Penalties for Altering Documents",
            "mapping": "AtlaSent's permit chain proves deletions were authorized and executed within proper governance — distinguishing legitimate record management from document destruction.\n",
            "evidence_source": "audit_chain",
            "status_query": "sox_deletion_governance_pct"
        }
    ],
    evidence_requirements: {
        "minimum_pattern": "EP-02",
        "approval_artifact_required": false,
        "state_snapshot_required": true,
        "notes": "State snapshot should capture a hash of the records being deleted and a count. For GDPR erasure, include the data subject identifier in the evaluate context.\n"
    },
    use_case: `Gate all data deletions with documented authorization, state snapshots, and reason capture — creating erasure certificates for GDPR Art. 17 compliance and preventing AI agents from autonomously deleting production data.`,
    industries: ["saas", "fintech", "healthtech", "enterprise", "regulated-industries"],
  },
  {
    id: "ACT-0009",
    slug: "access.grant",
    display_name: "Access Grant",
    description: `Authorization gate for granting privileged access — IAM roles, group memberships, elevated permissions, API key provisioning, and service account grants. Access grants are the most consequential identity operation: they expand the privilege surface permanently until revoked. Unauthorized grants enable privilege escalation, lateral movement, and persistent access for attackers. Requires human approval and quorum to prevent unilateral privilege escalation.`,
    family: "identity.grant",
    risk_posture: "critical",
    ai_risk: "Extreme",
    gate_flags: {
      requires_human_approval: true,
      requires_mfa: false,
      requires_verified_actor: false,
      requires_state_snapshot: true,
      required_assertion_classes: [],
    },
    authorization_pattern: {
      type: "quorum",
      machine_executable: false,
      minimum_approvals: 2,
    },
    regulatory_mappings: [
        {
            "framework": "sox",
            "clause": "SOX §404 — Access Control as Internal Control",
            "mapping": "AtlaSent creates a tamper-evident permit for every access grant, proving privileged access was authorized through a documented human approval chain — satisfying PCAOB access control evidence requirements.\n",
            "evidence_source": "audit_chain",
            "status_query": "access_grant_human_approval_pct"
        },
        {
            "framework": "pci_dss",
            "clause": "PCI DSS v4.0 Req. 7 — Restrict Access to System Components",
            "mapping": "AtlaSent enforces the authorization requirement before any access grant, ensuring the principle of least privilege is enforced with documented human approval.\n",
            "evidence_source": "permit_record",
            "status_query": "pci_access_grant_authorization_pct"
        },
        {
            "framework": "hipaa",
            "clause": "HIPAA §164.308(a)(3) — Workforce Access Management",
            "mapping": "AtlaSent gates access grants to ePHI systems with human approval and audit trail, satisfying HIPAA workforce access management requirements.\n",
            "evidence_source": "evaluation_record",
            "status_query": "hipaa_access_grant_gate_pct"
        },
        {
            "framework": "nist_800_53",
            "clause": "NIST SP 800-53 Rev.5 AC-2 — Account Management",
            "mapping": "AtlaSent enforces the formal approval requirement of NIST AC-2(b) — the authorization request and approval must be documented before access is granted.\n",
            "evidence_source": "audit_chain",
            "status_query": "nist_ac2_access_grant_pct"
        }
    ],
    evidence_requirements: {
        "minimum_pattern": "EP-03",
        "approval_artifact_required": true,
        "state_snapshot_required": true,
        "notes": "State snapshot should capture the current access configuration before the grant. The approval artifact must contain the business justification for the access request.\n"
    },
    use_case: `Enforce two-person integrity for all privileged access grants — IAM roles, group memberships, elevated permissions. Every grant requires human approval with a documented business justification and a tamper-evident audit chain.`,
    industries: ["fintech", "healthtech", "enterprise", "regulated-industries", "saas"],
  },
  {
    id: "ACT-0010",
    slug: "access.revoke",
    display_name: "Access Revocation",
    description: `Authorization gate for revoking access — removing IAM roles, group memberships, elevated permissions, or deprovisioning accounts. Unlike access grants, revocations are often time-critical during security incidents; requiring human approval would delay incident response. Instead, this action gates revocations with role verification and an immutable audit trail, ensuring every revocation is attributed and documented without blocking the speed needed for offboarding or incident containment.`,
    family: "identity.grant",
    risk_posture: "critical",
    ai_risk: "Extreme",
    gate_flags: {
      requires_human_approval: false,
      requires_mfa: false,
      requires_verified_actor: false,
      requires_state_snapshot: true,
      required_assertion_classes: [],
    },
    authorization_pattern: {
      type: "role-only",
      machine_executable: true,
    },
    regulatory_mappings: [
        {
            "framework": "nist_800_53",
            "clause": "NIST SP 800-53 Rev.5 AC-2(j) — Account Management: Disable Accounts",
            "mapping": "AtlaSent ensures every access revocation is attributed, timestamped, and linked to an immutable audit event — satisfying NIST AC-2(j) requirements for timely account disabling with documented evidence.\n",
            "evidence_source": "audit_chain",
            "status_query": "access_revoke_audit_coverage"
        },
        {
            "framework": "sox",
            "clause": "SOX §404 — Termination and Access Removal Controls",
            "mapping": "AtlaSent creates a tamper-evident record of access removals, proving terminated employees and contractors lost access within the required timeframe — a standard SOX §404 evidence point.\n",
            "evidence_source": "permit_record",
            "status_query": "sox_offboarding_revoke_pct"
        }
    ],
    evidence_requirements: {
        "minimum_pattern": "EP-01",
        "approval_artifact_required": false,
        "state_snapshot_required": true,
        "notes": "State snapshot should capture the access configuration being revoked. Include the revocation reason (offboarding, incident response, role change) in evaluate context.\n"
    },
    use_case: `Create an immutable audit trail for every access revocation — offboarding, incident response, role changes — without slowing down the revocation speed needed during security incidents.`,
    industries: ["fintech", "healthtech", "enterprise", "regulated-industries"],
  },
  {
    id: "ACT-0011",
    slug: "control.override",
    display_name: "Control Override",
    description: `Authorization gate for bypassing a security or compliance control — break-glass access, policy exceptions, emergency overrides, firewall rule bypasses, and regulatory exemptions. Control overrides are the highest-risk action class: they deliberately disable a protective control, creating a window of elevated risk. Every override must be justified, attributed to a verified human actor with MFA, and the risk must be contemporaneously assessed. AI agents must never override security controls autonomously.`,
    family: "privileged.operation",
    risk_posture: "critical",
    ai_risk: "Extreme",
    gate_flags: {
      requires_human_approval: true,
      requires_mfa: true,
      requires_verified_actor: true,
      requires_state_snapshot: false,
      required_assertion_classes: ["risk", "identity"],
    },
    authorization_pattern: {
      type: "approval-chain",
      machine_executable: false,
    },
    regulatory_mappings: [
        {
            "framework": "pci_dss",
            "clause": "PCI DSS v4.0 Req. 10.2 — Audit Logs for Security Control Bypasses",
            "mapping": "AtlaSent creates an immutable record of every security control bypass with the identity of the actor, the risk assessment, and the justification — satisfying PCI DSS requirements for override logging.\n",
            "evidence_source": "audit_chain",
            "status_query": "pci_override_audit_pct"
        },
        {
            "framework": "sox",
            "clause": "SOX §404 — Override of Internal Controls",
            "mapping": "AtlaSent ensures overrides of internal controls are documented with the authorizer's identity and business justification, satisfying PCAOB requirements for management override documentation.\n",
            "evidence_source": "audit_chain",
            "status_query": "sox_override_documentation_pct"
        },
        {
            "framework": "nist_800_53",
            "clause": "NIST SP 800-53 Rev.5 AC-17 — Remote Access",
            "mapping": "AtlaSent gates emergency access overrides with MFA, verified actor identity, and contemporaneous risk assessment — satisfying NIST AC-17 requirements for monitored and controlled privileged remote access.\n",
            "evidence_source": "permit_record",
            "status_query": "nist_override_gate_pct"
        }
    ],
    evidence_requirements: {
        "minimum_pattern": "EP-05",
        "approval_artifact_required": true,
        "state_snapshot_required": false,
        "required_assertions": [
            "risk",
            "identity"
        ],
        "notes": "The risk assertion must describe the specific control being bypassed and the accepted risk. The identity assertion proves the actor is who they claim to be at override time. Both must be present for the permit to be issued.\n"
    },
    use_case: `Gate every security control override — break-glass access, emergency bypasses, policy exceptions — with MFA, verified identity, human approval, and a contemporaneous risk assessment. Every override is permanently attributed and auditable.`,
    industries: ["fintech", "healthtech", "enterprise", "regulated-industries", "government"],
  },
  {
    id: "ACT-0013",
    slug: "content.publish",
    display_name: "Content Publication",
    description: `Authorization gate for publishing regulated content — medical device documentation, IFUs, SOPs, labeling, regulatory submissions, clinical study reports, and controlled documents. In regulated industries, a document released without proper authorization constitutes a quality system non-conformance. State snapshot binding captures the document hash at publication time, enabling version traceability.`,
    family: "regulated.release",
    risk_posture: "high",
    ai_risk: "High",
    gate_flags: {
      requires_human_approval: false,
      requires_mfa: false,
      requires_verified_actor: false,
      requires_state_snapshot: true,
      required_assertion_classes: [],
    },
    authorization_pattern: {
      type: "role-only",
      machine_executable: true,
    },
    regulatory_mappings: [
        {
            "framework": "21cfr_part_11",
            "clause": "21 CFR Part 11 §11.10 — Controls for Closed Systems",
            "mapping": "AtlaSent captures the author identity, document hash, and authorization record for every content publication — satisfying FDA document control requirements for electronic records in validated systems.\n",
            "evidence_source": "audit_chain",
            "status_query": "cfr11_content_publish_pct"
        },
        {
            "framework": "iso27001",
            "clause": "ISO/IEC 27001:2022 A.5.37 — Documented Operating Procedures",
            "mapping": "AtlaSent ensures documented operating procedures are published through an authorized channel with an immutable record of who released the document and when.\n",
            "evidence_source": "permit_record",
            "status_query": "iso27001_documented_procedures_pct"
        }
    ],
    evidence_requirements: {
        "minimum_pattern": "EP-02",
        "approval_artifact_required": false,
        "state_snapshot_required": true,
        "notes": "State snapshot must include the document hash (SHA-256 of final content) and the document version number. For FDA submissions, include the eCTD sequence number.\n"
    },
    use_case: `Gate publication of all regulated documents — medical device IFUs, SOPs, labeling, clinical study reports — with document hash binding and author attribution, creating a tamper-evident record of every controlled document release.`,
    industries: ["life-sciences", "healthtech", "medtech", "regulated-industries"],
  },
  {
    id: "ACT-0014",
    slug: "identity.sign",
    display_name: "Identity Signature",
    description: `Authorization gate for electronic signature acts — signing regulated documents, certifying records, and affixing a legally significant identity to a decision. Electronic signatures are legal acts requiring human intent under 21 CFR Part 11, EU eIDAS, and the US eSign Act. This action structurally prevents machine execution: no AI agent, service account, or automated system can sign on behalf of a human. Requires MFA and identity + approval assertions to bind the signer's identity to the signature act.`,
    family: "identity.grant",
    risk_posture: "critical",
    ai_risk: "Extreme",
    gate_flags: {
      requires_human_approval: true,
      requires_mfa: true,
      requires_verified_actor: false,
      requires_state_snapshot: false,
      required_assertion_classes: ["identity", "approval"],
    },
    authorization_pattern: {
      type: "human-only",
      machine_executable: false,
    },
    regulatory_mappings: [
        {
            "framework": "21cfr_part_11",
            "clause": "21 CFR Part 11 §11.50 — Signature Manifestations",
            "mapping": "AtlaSent captures the printed name, date/time, and meaning of each electronic signature in the permit chain — satisfying FDA requirements that signatures be bound to the record with legal meaning.\n",
            "evidence_source": "audit_chain",
            "status_query": "cfr11_esignature_meaning_pct"
        },
        {
            "framework": "eu_ai_act",
            "clause": "EU AI Act Art. 26 — Qualified Electronic Signatures",
            "mapping": "AtlaSent ensures AI systems cannot sign as qualified signatories under eIDAS — the identity assertion requires a human principal, not an AI actor ID.\n",
            "evidence_source": "permit_record",
            "status_query": "eidas_human_signature_pct"
        },
        {
            "framework": "sox",
            "clause": "SOX §302 — CEO/CFO Certification",
            "mapping": "AtlaSent gates executive certifications with MFA and identity assertion, proving a human officer (not an automated system) affixed their signature to the certification.\n",
            "evidence_source": "audit_chain",
            "status_query": "sox_302_human_signatory_pct"
        }
    ],
    evidence_requirements: {
        "minimum_pattern": "EP-04",
        "approval_artifact_required": true,
        "state_snapshot_required": false,
        "required_assertions": [
            "identity",
            "approval"
        ],
        "notes": "The identity assertion must carry the signer's legal name and IdP-verified principal. The approval assertion must reference the specific document hash being signed. The approval_meaning field must capture what the signer is attesting to (21 CFR Part 11 §11.50(a)(2)).\n"
    },
    use_case: `Gate all regulated electronic signature acts — batch release certifications, clinical study reports, SOX officer certifications, EU AI Act conformity declarations — with MFA and identity assertions that prove a verified human (not AI) signed.`,
    industries: ["life-sciences", "healthtech", "fintech", "regulated-industries", "legal"],
  },
  {
    id: "ACT-0015",
    slug: "resource.create",
    display_name: "Resource Creation",
    description: `Authorization gate for creation of cloud resources, databases, infrastructure components, and managed services. Resource creation is the origin point of all infrastructure; without attribution at creation time, the lineage of production resources is opaque. State snapshot binding captures the desired configuration at authorization time, preventing configuration drift between approval and provisioning.`,
    family: "infrastructure.change",
    risk_posture: "standard",
    ai_risk: "Low",
    gate_flags: {
      requires_human_approval: false,
      requires_mfa: false,
      requires_verified_actor: false,
      requires_state_snapshot: true,
      required_assertion_classes: [],
    },
    authorization_pattern: {
      type: "role-only",
      machine_executable: true,
    },
    regulatory_mappings: [
        {
            "framework": "sox",
            "clause": "SOX §404 — Change Management for IT Systems",
            "mapping": "AtlaSent attributes every resource creation to an authorized actor with an immutable timestamp — satisfying SOX change management documentation requirements for new IT system components.\n",
            "evidence_source": "audit_chain",
            "status_query": "resource_create_attribution_pct"
        },
        {
            "framework": "iso27001",
            "clause": "ISO/IEC 27001:2022 A.8.1 — Inventory of Assets",
            "mapping": "AtlaSent's permit chain creates an authoritative record of every resource creation, supporting the asset inventory requirements of ISO 27001 A.8.1.\n",
            "evidence_source": "permit_record",
            "status_query": "iso27001_asset_creation_pct"
        }
    ],
    evidence_requirements: {
        "minimum_pattern": "EP-01",
        "approval_artifact_required": false,
        "state_snapshot_required": true,
        "notes": "State snapshot should include the Terraform plan hash or cloud configuration manifest hash at authorization time. Include the target region and resource type.\n"
    },
    use_case: `Attribute every cloud resource creation to an authorized actor with a configuration hash — preventing shadow IT, enabling asset lifecycle governance, and satisfying SOX and ISO 27001 change management requirements.`,
    industries: ["saas", "enterprise", "fintech", "regulated-industries"],
  },
  {
    id: "ACT-0016",
    slug: "resource.destroy",
    display_name: "Resource Destruction",
    description: `Authorization gate for irreversible destruction of cloud resources, databases, storage buckets, and infrastructure components. Resource destruction is one of the highest-risk infrastructure operations — a mistaken or unauthorized destroy can cause catastrophic data loss, extended outages, and regulatory violations. Requires the strongest gate: human approval, MFA, verified actor identity, and a contemporaneous risk assessment proving the actor understood the consequences before proceeding.`,
    family: "infrastructure.change",
    risk_posture: "critical",
    ai_risk: "High",
    gate_flags: {
      requires_human_approval: true,
      requires_mfa: true,
      requires_verified_actor: true,
      requires_state_snapshot: false,
      required_assertion_classes: ["risk", "identity"],
    },
    authorization_pattern: {
      type: "quorum",
      machine_executable: false,
      minimum_approvals: 2,
    },
    regulatory_mappings: [
        {
            "framework": "hipaa",
            "clause": "HIPAA §164.310(d)(2)(i) — Media Disposal",
            "mapping": "AtlaSent creates an authorized destruction record proving data was deliberately destroyed by an authorized actor — satisfying HIPAA disposal documentation requirements.\n",
            "evidence_source": "audit_chain",
            "status_query": "hipaa_disposal_authorization_pct"
        },
        {
            "framework": "gdpr",
            "clause": "GDPR Art. 17 — Right to Erasure",
            "mapping": "AtlaSent's destruction permit proves irreversible deletion was authorized and executed, providing the documented erasure evidence GDPR Art. 17 requires.\n",
            "evidence_source": "permit_record",
            "status_query": "gdpr_destruction_documentation_pct"
        },
        {
            "framework": "sox",
            "clause": "SOX §802 — Document Retention and Destruction",
            "mapping": "AtlaSent ensures resource destruction is authorized through proper governance and distinguishes legitimate decommissioning from unauthorized destruction of SOX-relevant systems.\n",
            "evidence_source": "audit_chain",
            "status_query": "sox_destruction_governance_pct"
        }
    ],
    evidence_requirements: {
        "minimum_pattern": "EP-05",
        "approval_artifact_required": true,
        "state_snapshot_required": false,
        "required_assertions": [
            "risk",
            "identity"
        ],
        "notes": "The risk assertion must identify the specific resources being destroyed and confirm the actor understands the irreversibility. The identity assertion proves both approvers are who they claim to be.\n"
    },
    use_case: `Prevent catastrophic data loss from unauthorized or mistaken infrastructure destruction. Every destroy operation requires two human approvers with MFA, verified identities, and a contemporaneous risk assessment — no AI agent or solo admin can destroy production resources.`,
    industries: ["fintech", "healthtech", "enterprise", "saas", "regulated-industries"],
  },
  {
    id: "ACT-0017",
    slug: "service.suspend",
    display_name: "Service Suspension",
    description: `Authorization gate for deliberate suspension of a production service — taking a service offline for maintenance, as an incident response action, or as a business decision. Service suspension has direct customer impact through SLA obligations and availability commitments. State snapshot binding captures the pre-suspension service state, enabling documented justification and post-suspension comparison.`,
    family: "infrastructure.change",
    risk_posture: "high",
    ai_risk: "High",
    gate_flags: {
      requires_human_approval: false,
      requires_mfa: false,
      requires_verified_actor: false,
      requires_state_snapshot: true,
      required_assertion_classes: [],
    },
    authorization_pattern: {
      type: "role-only",
      machine_executable: true,
    },
    regulatory_mappings: [
        {
            "framework": "iso27001",
            "clause": "ISO/IEC 27001:2022 A.8.14 — Redundancy of Information Processing Facilities",
            "mapping": "AtlaSent documents every deliberate service suspension with actor identity and business justification — satisfying ISO 27001 change management requirements for availability decisions.\n",
            "evidence_source": "audit_chain",
            "status_query": "service_suspend_documented_pct"
        }
    ],
    evidence_requirements: {
        "minimum_pattern": "EP-02",
        "approval_artifact_required": false,
        "state_snapshot_required": true,
        "notes": "State snapshot should capture the service health metrics at suspension time — error rate, latency p99, active connections. Include the expected suspension duration and customer impact scope in the evaluate context.\n"
    },
    use_case: `Document every deliberate service suspension with actor attribution, service state snapshot, and justification — creating the governance record needed for SLA compliance and post-incident reviews.`,
    industries: ["saas", "fintech", "enterprise", "regulated-industries"],
  },
  {
    id: "ACT-0018",
    slug: "service.resume",
    display_name: "Service Resumption",
    description: `Authorization gate for resuming a suspended service — bringing a service back online after planned or emergency maintenance. Service resumption carries its own risks: resuming a service before the underlying issue is resolved can cause immediate re-failure. State snapshot binding captures the post-fix service configuration, enabling documented validation that the root cause was addressed before resumption.`,
    family: "infrastructure.change",
    risk_posture: "high",
    ai_risk: "High",
    gate_flags: {
      requires_human_approval: false,
      requires_mfa: false,
      requires_verified_actor: false,
      requires_state_snapshot: true,
      required_assertion_classes: [],
    },
    authorization_pattern: {
      type: "role-only",
      machine_executable: true,
    },
    regulatory_mappings: [
        {
            "framework": "iso27001",
            "clause": "ISO/IEC 27001:2022 A.8.14 — Redundancy and Recovery",
            "mapping": "AtlaSent documents every service resumption with actor identity and validation evidence — satisfying ISO 27001 requirements for documented recovery procedures.\n",
            "evidence_source": "audit_chain",
            "status_query": "service_resume_documented_pct"
        }
    ],
    evidence_requirements: {
        "minimum_pattern": "EP-02",
        "approval_artifact_required": false,
        "state_snapshot_required": true,
        "notes": "State snapshot should capture the post-fix service configuration. Include the root cause summary and validation steps completed in the evaluate context — these become the SLA restoration evidence.\n"
    },
    use_case: `Document every service resumption with actor attribution, post-fix configuration state, and root cause summary — creating the SLA restoration evidence and post-incident closure record that compliance and customers require.`,
    industries: ["saas", "fintech", "enterprise"],
  },
  {
    id: "ACT-0019",
    slug: "workflow.escalate",
    display_name: "Workflow Escalation",
    description: `Authorization gate for workflow escalation steps — capturing the moment when an AI agent, automated system, or human acknowledges it cannot proceed without additional authority and escalates to a higher-level decision maker. Escalation is intentionally low-friction (any-role, no human approval gate) because the goal is to capture and attribute escalations, not to gate them. A well-documented escalation trail proves AI agents recognized their limits and deferred to humans rather than proceeding autonomously.`,
    family: "production.deploy",
    risk_posture: "standard",
    ai_risk: "Low",
    gate_flags: {
      requires_human_approval: false,
      requires_mfa: false,
      requires_verified_actor: false,
      requires_state_snapshot: false,
      required_assertion_classes: [],
    },
    authorization_pattern: {
      type: "any-role",
      machine_executable: true,
    },
    regulatory_mappings: [
        {
            "framework": "sox",
            "clause": "SOX §404 — Escalation Procedures as Internal Controls",
            "mapping": "AtlaSent creates an immutable record of escalation events, proving that exception-handling procedures were followed and escalations were properly attributed and documented.\n",
            "evidence_source": "audit_chain",
            "status_query": "escalation_audit_coverage"
        }
    ],
    evidence_requirements: {
        "minimum_pattern": "EP-01",
        "approval_artifact_required": false,
        "state_snapshot_required": false,
        "notes": "The evaluate context should include the escalation reason, the decision being escalated, and the target escalation recipient. This context becomes the escalation evidence in the audit chain.\n"
    },
    use_case: `Create an audit trail of every escalation event — proving AI agents recognized their limits and deferred to humans rather than proceeding autonomously. The escalation chain becomes evidence of appropriate human-AI collaboration.`,
    industries: ["saas", "enterprise", "regulated-industries", "fintech", "healthtech"],
  },
  {
    id: "ACT-0020",
    slug: "compliance.certify",
    display_name: "Compliance Certification",
    description: `Authorization gate for compliance certification acts — EU AI Act declarations of conformity, SOX §302 CEO/CFO certifications, GxP Qualified Person batch release certifications, HIPAA compliance officer certifications, and ISO/IEC conformity attestations. These are legal acts performed by a qualified authority with personal accountability. No AI system may certify compliance on behalf of a human — this action is structurally machine-blocked. Requires MFA, a qualified human authority, and regulatory + identity + approval assertions proving the certifier understood and accepted the obligations they are certifying.`,
    family: "regulated.release",
    risk_posture: "critical",
    ai_risk: "Extreme",
    gate_flags: {
      requires_human_approval: true,
      requires_mfa: true,
      requires_verified_actor: false,
      requires_state_snapshot: false,
      required_assertion_classes: ["regulatory", "identity", "approval"],
    },
    authorization_pattern: {
      type: "human-only",
      machine_executable: false,
    },
    regulatory_mappings: [
        {
            "framework": "eu_ai_act",
            "clause": "EU AI Act Art. 47-49 — Declaration of Conformity",
            "mapping": "AtlaSent gates conformity declarations with a qualified human authority, MFA, and a regulatory assertion confirming the specific requirements being certified — proving the declaration was made by a natural person, not an automated system.\n",
            "evidence_source": "audit_chain",
            "status_query": "eu_ai_act_declaration_human_pct"
        },
        {
            "framework": "sox",
            "clause": "SOX §302 — Corporate Responsibility for Financial Reports",
            "mapping": "AtlaSent ensures SOX §302 certifications are performed by the human CEO/CFO with MFA, creating a tamper-evident record that the certification was performed by a natural person with personal liability — not an automated reporting system.\n",
            "evidence_source": "audit_chain",
            "status_query": "sox_302_human_certification_pct"
        },
        {
            "framework": "21cfr_part_11",
            "clause": "21 CFR Part 11 §11.50 — Electronic Signature Requirements for Certifications",
            "mapping": "AtlaSent captures the Qualified Person's MFA-verified signature, the meaning of the certification, and the regulatory basis — satisfying FDA requirements for electronic batch release certifications.\n",
            "evidence_source": "permit_record",
            "status_query": "cfr11_qp_certification_pct"
        },
        {
            "framework": "hipaa",
            "clause": "HIPAA §164.308(a)(8) — Evaluation Requirements",
            "mapping": "AtlaSent gates HIPAA compliance certifications with a compliance officer's authenticated identity — proving evaluations were performed by an authorized human officer, not an automated compliance tool.\n",
            "evidence_source": "evaluation_record",
            "status_query": "hipaa_compliance_eval_human_pct"
        }
    ],
    evidence_requirements: {
        "minimum_pattern": "EP-05",
        "approval_artifact_required": true,
        "state_snapshot_required": false,
        "required_assertions": [
            "regulatory",
            "identity",
            "approval"
        ],
        "notes": "The regulatory assertion must identify the specific framework, clause, and scope being certified. The identity assertion must prove the certifier holds the required authority (e.g., QP qualification for batch release, CEO/CFO role for SOX §302). The approval assertion must capture the certification meaning (per 21 CFR Part 11 §11.50(a)(2)).\n"
    },
    use_case: `Gate all compliance certification acts — EU AI Act conformity declarations, SOX §302 certifications, GxP QP batch releases, HIPAA compliance evaluations — with a verified human qualified authority, MFA, and regulatory + identity + approval assertions that prove a natural person certified, not an AI system.`,
    industries: ["life-sciences", "fintech", "regulated-industries", "enterprise", "healthtech"],
  },
];
