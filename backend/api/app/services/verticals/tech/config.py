"""Tech vertical — RoleFamilyProfile config."""
from __future__ import annotations

from app.enums import CertPolicy, HeadlineBucket, InjectionPolicy
from app.services.verticals.base import RoleFamilyProfile

PROFILE = RoleFamilyProfile(
    id="tech",
    label="IT / Tech / Data",
    aliases=[
        "data analyst", "data scientist", "data engineer", "analytics",
        "business intelligence", "bi developer", "software", "developer",
        "engineer", "machine learning", "ml ", "ai ", "devops", "it support",
        "systems analyst", "programmer", "full stack", "backend", "frontend",
        "cloud", "platform",
    ],
    section_order=[
        "Career Highlights", "Professional Experience", "Education",
        "Skills", "Projects", "Certifications",
    ],
    skills_categories=["Technical Skills", "Soft Skills", "Other Skills"],
    cert_policy=CertPolicy.PLUS,
    injection_policy=InjectionPolicy.AGGRESSIVE,
    metric_vocab=[
        "users", "records", "rows", "queries", "dashboards", "reports",
        "uptime", "latency", "accuracy", "models", "pipelines", "datasets",
        "%", "requests", "deployments",
    ],
    identity_guidance=(
        "IDENTITY SCAN — run FIRST, before deciding anything else. Count "
        "AI/ML signal words in the JD: LLM, GPT, Claude, transformer, RAG, "
        "embedding, deep learning, neural network, computer vision, NLP, "
        "PyTorch, TensorFlow, scikit-learn, ML model, AI engineer, ML "
        "engineer, AI/ML, machine learning, model training, fine-tuning, "
        "MLOps, research, publication. Pick ONE mode for the entire output:\n"
        "  • Signal count ≥ 2 → AI-FORWARD MODE. Lead with AI/ML identity; "
        "keep AI projects/bullets/skills.\n"
        "  • Signal count = 0 → AI-SUPPRESSED MODE (HARD). Identity is the "
        "JD's single base title (e.g. 'Data Analyst', 'Software Engineer'), "
        "NEVER a hybrid. Drop the AI/ML half from BOTH the summary opener "
        "AND every Experience role title — even if the source CV chains "
        "them as 'X & AI Engineer'. Drop AI vocabulary (LLM, model "
        "training, deep learning, CV/NLP, fine-tuning) from Career "
        "Highlights entirely. Drop AI-only frameworks (PyTorch, TensorFlow, "
        "scikit-learn, Hugging Face) from Skills. Prefer JD-aligned "
        "roles/projects over AI-evaluation/training roles.\n"
        "  • Signal count = 1 → JUDGEMENT CALL. Default to suppression "
        "unless the single signal is core to the JD's primary methodology.\n"
        "Once Mode is picked, it controls every downstream choice."
    ),
    extra_rules=(
        "PROJECT RANKING (HARD) — rank every CV project by three keys, in "
        "this order: (1) Q2 = tech-stack match to the JD, (2) Q1 = domain "
        "match to the JD, (3) headline metrics. Q2 = yes ALWAYS outranks "
        "Q2 = no, regardless of how impressive the no-match project's "
        "numbers are. A SQL/ETL project with '30% time saved' outranks an "
        "ML project with '92% accuracy' when the JD is SQL/Power BI. Among "
        "Q2 = no projects, Q1 = yes outranks Q1 = no. Headline metrics "
        "break ties ONLY when relevance is equal. Pick the top 2 from that "
        "ranking; never let metric flash decide above relevance.\n\n"
        "PROJECT RANKING — worked example: JD is SQL/Power BI Data Analyst. "
        "Candidate projects: [CV Agent (Flutter, Multi-LLM), YOLOv8 (PyTorch, "
        "Computer Vision, 92% accuracy), SQL Pipeline (SQL, PostgreSQL, ETL, "
        "30% time saved)]. Rank: SQL Pipeline (Q2=yes — direct stack hit) "
        "beats every Q2=no project, including YOLOv8 despite the 92%. CV "
        "Agent (Q2=no but has full-stack/scale framing) > YOLOv8 (Q2=no, "
        "pure CV). Output: SQL Pipeline first, CV Agent second.\n\n"
        "TECHNICAL SKILLS LINE — may use ` | ` separators for up to 3 "
        "logical sub-groups when there are ≥9 technical entries (languages "
        "| BI tools | cloud). One space on EACH side of the pipe; the "
        "separator is ASCII U+007C, never capital I or lowercase l — those "
        "break ATS parsing. Example: 'Python, SQL, R | Power BI, Tableau | "
        "AWS, Snowflake'. With fewer than 9 entries, write a single comma "
        "list — do not force sub-groups when there is nothing to group.\n\n"
        "SKILLS NUMERIC CAPS (HARD): Technical Skills 10-14 entries, Soft "
        "Skills 4-6 entries, Other Skills 5-8 entries. When the candidate's "
        "raw skill set exceeds a cap, drop the LEAST JD-relevant items "
        "first, never the most relevant. Padding to hit a count is "
        "forbidden.\n\n"
        "SKILLS MINIMUM FLOOR (HARD): at least 5 total entries across all "
        "three lines after JD-relevance filtering. If filtering leaves "
        "fewer than 5, pad Technical Skills with the candidate's most "
        "impactful tools (even if not in the JD) until the total reaches "
        "5. Never pad with irrelevant skills beyond the floor.\n\n"
        "CATEGORY PLACEMENT (HARD): methodologies and domain terms go in "
        "**Other Skills**, never Technical. Technical = languages, "
        "libraries, platforms, databases, BI tools, cloud services, ML "
        "frameworks ONLY. 'Predictive Analytics', 'Statistical Analysis', "
        "'ETL Pipelines', 'A/B Testing', 'Data Warehousing', 'Marketing "
        "Analytics', 'Stakeholder Management' → Other Skills. Never "
        "duplicate a skill across two lines.\n\n"
        "CAREER HIGHLIGHTS PRE-WRITE 7-STEP CHECK — before emitting the "
        "summary, internally verify all of: (1) S1 word count ≤ 28? (2) S2 "
        "word count ≤ 22? (3) Total 35-50? (4) Either sentence names a "
        "tool (Python, SQL, Power BI, PostgreSQL, AWS)? If yes, replace "
        "the tool name with the method/outcome the tool enabled. (5) Does "
        "S2 contain a number or named deliverable? (6) If 2+ Experience "
        "roles kept, does S2 contain TWO clauses joined by a semicolon, "
        "one anchored to each top role? (7) Any seniority word in S1 "
        "(Senior/Lead/Principal/Manager) actually present in the "
        "candidate's CV titles? Only emit Career Highlights after all 7 "
        "pass."
    ),
    equivalences=[
        ("SQL", ["postgresql", "postgres", "mysql", "sql server", "t-sql",
                 "pl/sql", "sqlite", "oracle", "mariadb"], "technical"),
        ("Relational Databases", ["postgresql", "mysql", "sql server",
                                  "oracle", "sqlite", "mariadb"], "technical"),
        ("NoSQL", ["mongodb", "cassandra", "dynamodb", "redis", "couchbase"], "technical"),
        ("Cloud", ["aws", "azure", "gcp", "google cloud"], "technical"),
        ("CI/CD", ["github actions", "gitlab ci", "jenkins", "circleci", "travis"], "technical"),
        ("Data Visualisation", ["power bi", "tableau", "looker", "matplotlib",
                                "seaborn", "plotly", "qlik"], "technical"),
        ("PostgreSQL", ["sql", "postgres", "psql"], "technical"),
    ],
)
