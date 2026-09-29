import assert from "node:assert/strict";
import { extractVerification, evaluateChallenge, wordsToMath } from "./components/moltbook-core.js";

const nestedPost = {
  success: true,
  post: {
    id: "post-1",
    verification: {
      verification_code: "verify-post",
      challenge_text: "Fifteen newtons and seven newtons, how much total force?",
    },
  },
};
assert.deepEqual(extractVerification(nestedPost), {
  code: "verify-post",
  challenge: "Fifteen newtons and seven newtons, how much total force?",
});

const nestedComment = {
  comment: {
    id: "comment-1",
    verification: {
      verification_code: "verify-comment",
      challenge_text: "Thirty five newtons and twelve newtons, total force?",
    },
  },
};
assert.deepEqual(extractVerification(nestedComment), {
  code: "verify-comment",
  challenge: "Thirty five newtons and twelve newtons, total force?",
});

const legacy = {
  verification_code: "legacy-code",
  challenge: "20 + 5",
};
assert.deepEqual(extractVerification(legacy), {
  code: "legacy-code",
  challenge: "20 + 5",
});

assert.equal(
  evaluateChallenge("A lobster claw has fifteen newtons and another claw adds seven newtons. What is the total force?").formatted,
  "22.00",
);

assert.equal(
  evaluateChallenge("A lobster swims at twenty three cm per second for four seconds. How far does it travel?").formatted,
  "92.00",
);

assert.equal(
  evaluateChallenge("A lobster swims at twenty three meters per second and accelerates by seven meters per second. What is the new velocity?").formatted,
  "30.00",
);

assert.equal(
  evaluateChallenge("Claw forces are thirty five newtons and twelve newtons. How much total force?").formatted,
  "47.00",
);

assert.equal(evaluateChallenge("123 + 456").formatted, "579.00");
assert.match(wordsToMath("thirty five and twelve"), /35\s*\+\s*12/);

const liveChallenges = [
  ["A] Lo.bSt-Er LoOobssT-er ClAw WwIth^ fIfTeEeN ] nOoToNs~ aNd{ aNoThEr } cLaW AdDs/ sEeVeN < nOoToNs, } hOw| mUcH ] tOtAl^ fOrCe-?", "22.00"],
  ["A] Lo.bSt-Er] SwImS^ LiKe Um] loOoobsssSteR anTEnNa TeStiNg- vElawCiTeE] aT/ tW/eNtY ThReE Cm^ PeR] sEcOnD sOoOo/ fOr] fOuR SeC, HoW/ fAr Is ThE] tRaVeL?", "92.00"],
  ["A] LoObBsStTeErR sW/iMs} aT{ TwEnTy ThReE ]cMe^tErS PeR SeCoNd - aNd~ aCcElErAtEs\\ By SeVeN cMe^tErS PeR SeCoNd, WhAt] Is^ ThE NeW VeLoCiTy?", "30.00"],
  ["A] Lo.bSt-Er| sWImS^ iN tEr RItOrY] wAtEr- AnD/ iN a D0mInAnCe] fIt, cLaW| fOrCeS aRe^ tHiRtY fIvE] nEeW tOnS- aNd/ tWeLvE, HoW] mUcH^ tOtAl| fOrCe?", "47.00"],
  ["A] Lo.O bS tErRr S^wImS[ aT/ TwEnTy ThReE MeTeRs^ PeR MiN uTe, Um- ItS ClAwWw GaInS] SeVeN NoOtOnS~, WhAt Is- ThE PrOdUcT< Of/ TwEnTy ThReE & SeVeN>?", "161.00"],
];
for (const [challenge, expected] of liveChallenges) {
  assert.equal(evaluateChallenge(challenge).formatted, expected);
}

console.log("moltbook verification tests: ok");
