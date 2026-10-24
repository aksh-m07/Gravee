"""
Train a failure-mode detector on MAST-Data (Cemri et al., 2025, "Why Do Multi-Agent LLM Systems Fail?", arXiv 2503.13657; CC-BY-4.0).

  python3 -I scripts/train-mast.py <MAD_full_dataset.json> <out_model.json> <out_eval.json>

The question that matters for a guard is: does it work on an agent framework it has never seen? So:

  * Design phase: leave-one-framework-out among AG2, MetaGPT and ChatDev (training on the other two). Several configurations are compared here.
    Magentic is NOT used for any design choice.
  * Final test: the configuration chosen in the design phase is trained on AG2+MetaGPT+ChatDev and scored ONCE on Magentic.
  * The first, naive configuration (all words, weak regularisation) is reported next to it.

Configurations differ in three ways: whether the vocabulary is limited to words that are common across training frameworks (so the model cannot lean on
one framework's jargon), whether three simple structure signals are added (trace length, line count, share of repeated lines), and the regularisation strength.

Text is normalised (lower case, digits -> 0, symbols and very long tokens dropped) and cut to the first 12k and last 12k characters.
Labels in the full set were produced by an LLM annotator validated against humans by the dataset authors. They are not gold.
Everything here is about multi-agent software traces. None of it has been validated on browser agents.
"""
import json, math, re, sys
import numpy as np
from scipy import sparse
from sklearn.feature_extraction.text import CountVectorizer, TfidfTransformer
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import roc_auc_score

MODES = ["1.1", "1.2", "1.3", "1.4", "1.5", "2.1", "2.2", "2.3", "2.4", "2.5", "2.6", "3.1", "3.2", "3.3"]
NAMES = {
    "1.1": "Disobey task specification", "1.2": "Disobey role specification", "1.3": "Step repetition", "1.4": "Loss of conversation history",
    "1.5": "Unaware of termination conditions", "2.1": "Conversation reset", "2.2": "Fail to ask for clarification", "2.3": "Task derailment",
    "2.4": "Information withholding", "2.5": "Ignored other agent's input", "2.6": "Reasoning-action mismatch", "3.1": "Premature termination",
    "3.2": "No or incomplete verification", "3.3": "Incorrect verification",
}
HEAD = TAIL = 12000
DESIGN_FW = ["AG2", "MetaGPT", "ChatDev"]
CONFIGS = {
    "A  naive: all words, C=1": dict(C=1.0),
    "A2 all words, C=0.1": dict(C=0.1),
    "B  words shared by >=2 training frameworks, C=1": dict(C=1.0, shared_k=2),
    "B2 shared words, C=0.1": dict(C=0.1, shared_k=2),
    "B3 shared words (>=3% of docs), C=0.1": dict(C=0.1, shared_k=2, min_share=0.03),
    "C  shared words + structure signals, C=0.1": dict(C=0.1, shared_k=2, struct=True),
}
NAIVE = "A  naive: all words, C=1"


def norm(t):
    t = t if len(t) <= HEAD + TAIL else t[:HEAD] + "\n" + t[-TAIL:]
    t = t.lower(); t = re.sub(r"\d+", "0", t); t = re.sub(r"[^a-z0 ?!.\n]", " ", t)
    return " ".join(w for w in t.split() if len(w) <= 18)


def struct(t):
    lines = [l.strip() for l in t.split("\n") if l.strip()]; n = max(1, len(lines))
    return [math.log1p(len(t)) / 15, math.log1p(n) / 10, 1 - len(set(lines)) / n]


class Data:
    def __init__(self, path):
        d = json.load(open(path))
        self.texts = [norm(r["trace"]["trajectory"]) for r in d]
        self.st = np.array([struct(r["trace"]["trajectory"][:400000]) for r in d])
        self.fw = np.array([r["mas_name"] for r in d])
        self.Y, self.OK = {}, {}
        for m in MODES:
            v = [r["mast_annotation"].get(m) for r in d]
            self.OK[m] = np.array([x is not None for x in v]); self.Y[m] = np.array([int(x) if x is not None else 0 for x in v])


def build(D, train_fw, cfg):
    tr = np.where(np.isin(D.fw, train_fw))[0]
    cv = CountVectorizer(ngram_range=(1, 2), min_df=3, max_features=60000, binary=True).fit([D.texts[i] for i in tr])
    cols = np.arange(len(cv.vocabulary_))
    if cfg.get("shared_k"):
        B = cv.transform([D.texts[i] for i in tr]).tocsc(); keep = np.zeros(B.shape[1], dtype=int)
        for f in train_fw:
            rows = np.where(D.fw[tr] == f)[0]
            if len(rows) < 20: continue
            keep += (np.asarray(B[rows].sum(axis=0)).ravel() / len(rows)) >= cfg.get("min_share", 0.015)
        cols = np.where(keep >= cfg["shared_k"])[0]
    tf = TfidfTransformer(sublinear_tf=True).fit(cv.transform([D.texts[i] for i in tr])[:, cols])
    def X(idx):
        M = tf.transform(cv.transform([D.texts[i] for i in idx])[:, cols])
        return sparse.hstack([M, sparse.csr_matrix(D.st[idx])]).tocsr() if cfg.get("struct") else M
    return cv, cols, tf, X, tr


def run(D, train_fw, test_fw, cfg):
    cv, cols, tf, X, tr = build(D, train_fw, cfg)
    te = np.where(D.fw == test_fw)[0]; Xtr, Xte = X(tr), X(te); out = {}
    for m in MODES:
        ok_tr, ok_te = D.OK[m][tr], D.OK[m][te]; ytr, yte = D.Y[m][tr][ok_tr], D.Y[m][te][ok_te]
        if ytr.sum() < 5 or yte.sum() < 10 or (len(yte) - yte.sum()) < 10: continue
        clf = LogisticRegression(C=cfg["C"], class_weight="balanced", max_iter=2000, solver="liblinear").fit(Xtr[ok_tr], ytr)
        out[m] = float(roc_auc_score(yte, clf.decision_function(Xte[ok_te])))
    return out


def main(data_path, model_path, eval_path):
    D = Data(data_path)
    design, chosen_score = {}, {}
    print("DESIGN PHASE: leave-one-framework-out among", DESIGN_FW, "(Magentic untouched)")
    for name, cfg in CONFIGS.items():
        per = {f: run(D, [x for x in DESIGN_FW if x != f], f, cfg) for f in DESIGN_FW}
        design[name] = per; chosen_score[name] = float(np.mean([np.mean(list(r.values())) for r in per.values()]))
        print(f"  {name:48s} " + "  ".join(f"{f}:{np.mean(list(r.values())):.3f}" for f, r in per.items()) + f"   mean {chosen_score[name]:.3f}")
    best = max(chosen_score, key=chosen_score.get)
    print("chosen on the design frameworks:", best)
    final = {n: run(D, DESIGN_FW, "Magentic", CONFIGS[n]) for n in (NAIVE, best)}
    print("\nFINAL, scored once on the untouched framework Magentic (trained on AG2+MetaGPT+ChatDev):")
    for n, r in final.items():
        print(f"  {n:48s} modes scored {len(r)}  mean AUC {np.mean(list(r.values())):.3f}")
    print("  per mode (chosen):", {m: round(v, 2) for m, v in final[best].items()})
    json.dump({
        "dataset": "MAST-Data (mcemri/MAST-Data, CC-BY-4.0), 1642 traces, 7 frameworks", "labels": "LLM-annotated by the dataset authors, validated against humans; not gold",
        "protocol": "design on AG2/MetaGPT/ChatDev leave-one-framework-out; chosen configuration scored once on Magentic",
        "design": {n: {"per_framework": {f: float(np.mean(list(r.values()))) for f, r in per.items()}, "mean": chosen_score[n]} for n, per in design.items()},
        "chosen": best, "naive": NAIVE,
        "final_magentic": {n: {"mean_auc": float(np.mean(list(r.values()))), "modes_scored": len(r), "per_mode": r} for n, r in final.items()},
        "mode_names": NAMES,
    }, open(eval_path, "w"), indent=1)
    # Export the chosen configuration trained on all frameworks, as plain JSON (no pickle). Not used by the guard.
    cfg = CONFIGS[best]; allfw = sorted(set(D.fw)); cv, cols, tf, X, tr = build(D, allfw, cfg); Xa = X(tr)
    inv = {i: t for t, i in cv.vocabulary_.items()}
    model = {"source": "MAST-Data (Cemri et al. 2025), CC-BY-4.0", "config": best, "vocab": [inv[int(c)] for c in cols], "idf": [float(x) for x in tf.idf_], "modes": {}}
    for m in MODES:
        ok = D.OK[m]
        if D.Y[m][ok].sum() < 20: continue
        clf = LogisticRegression(C=cfg["C"], class_weight="balanced", max_iter=2000, solver="liblinear").fit(Xa[ok], D.Y[m][ok])
        c = clf.coef_[0]; k = len(cols)
        model["modes"][m] = {"name": NAMES[m], "coef": [round(float(x), 4) for x in c[:k]], "struct": [round(float(x), 4) for x in c[k:]], "intercept": round(float(clf.intercept_[0]), 4)}
    json.dump(model, open(model_path, "w"))


if __name__ == "__main__":
    main(*sys.argv[1:4])
