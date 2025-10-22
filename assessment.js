import fetch from "node-fetch";

// ---------------- CONFIG ----------------
const BASE_URL = "https://assessment.ksensetech.com/api";
const API_KEY = "ak_c9d28887c947c0445aa5f3f583d8fc1f7bf2250f7fb4cd98";
const MAX_RETRIES = 5;
const RETRY_DELAY = 1000; // ms
const RATE_LIMIT_DELAY = 2000; // ms
const PAGE_LIMIT = 5;

// --------------- UTILS ------------------
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function safeFetch(url, options = {}, retries = 0) {
  try {
    const res = await fetch(url, options);
    if (res.status === 429) {
      console.warn(`Rate limited. Waiting ${RATE_LIMIT_DELAY}ms...`);
      await sleep(RATE_LIMIT_DELAY);
      return safeFetch(url, options, retries + 1);
    }
    if (res.status >= 500 && retries < MAX_RETRIES) {
      console.warn(
        `Server error ${res.status}. Retrying ${retries + 1}/${MAX_RETRIES}...`
      );
      await sleep(RETRY_DELAY * (retries + 1));
      return safeFetch(url, options, retries + 1);
    }
    return res;
  } catch (err) {
    if (retries < MAX_RETRIES) {
      console.warn(`Network error: ${err.message}. Retrying...`);
      await sleep(RETRY_DELAY);
      return safeFetch(url, options, retries + 1);
    }
    throw err;
  }
}

// ---------------- DATA FETCH ----------------
async function fetchAllPatients() {
  let page = 1;
  let patients = [];
  let hasNext = true;

  while (hasNext) {
    const url = `${BASE_URL}/patients?page=${page}&limit=${PAGE_LIMIT}`;
    const res = await safeFetch(url, {
      headers: { "x-api-key": API_KEY },
    });
    if (!res.ok) {
      console.error("Failed to fetch page:", page, await res.text());
      break;
    }
    const data = await res.json();
    if (data?.data?.length) patients.push(...data.data);
    hasNext = data?.pagination?.hasNext || false;
    page++;
  }
  return patients;
}

// ---------------- SCORING LOGIC ----------------

// Extract systolic & diastolic safely
function parseBloodPressure(bp) {
  if (!bp || typeof bp !== "string" || !bp.includes("/")) return [null, null];
  const [s, d] = bp.split("/").map((v) => parseInt(v));
  if (isNaN(s) || isNaN(d)) return [null, null];
  return [s, d];
}

function getBPScore(bp) {
  const [s, d] = parseBloodPressure(bp);
  if (s == null || d == null) return { score: 0, valid: false };
  if (s < 120 && d < 80) return { score: 0, valid: true };
  if (s >= 120 && s <= 129 && d < 80) return { score: 1, valid: true };
  if ((s >= 130 && s <= 139) || (d >= 80 && d <= 89))
    return { score: 2, valid: true };
  if (s >= 140 || d >= 90) return { score: 3, valid: true };
  return { score: 0, valid: false };
}

function getTempScore(temp) {
  const t = parseFloat(temp);
  if (isNaN(t)) return { score: 0, valid: false };
  if (t <= 99.5) return { score: 0, valid: true };
  if (t > 99.6 && t <= 100.9) return { score: 1, valid: true };
  if (t >= 101.0) return { score: 2, valid: true };
  return { score: 0, valid: false };
}

function getAgeScore(age) {
  const a = parseInt(age);
  if (isNaN(a)) return { score: 0, valid: false };
  if (a < 40) return { score: 0, valid: true };
  if (a >= 40 && a <= 65) return { score: 1, valid: true };
  if (a > 65) return { score: 2, valid: true };
  return { score: 0, valid: false };
}

// ---------------- MAIN LOGIC ----------------
async function runAssessment() {
  console.log("Fetching patient data...");
  const patients = await fetchAllPatients();
  console.log(`Fetched ${patients.length} patients.`);

  const highRisk = [];
  const feverPatients = [];
  const dataQuality = [];

  for (const p of patients) {
    const bp = getBPScore(p.blood_pressure);
    const temp = getTempScore(p.temperature);
    const age = getAgeScore(p.age);

    const valid = bp.valid && temp.valid && age.valid;
    const totalScore = bp.score + temp.score + age.score;

    if (!valid) dataQuality.push(p.patient_id);
    if (valid && totalScore >= 4) highRisk.push(p.patient_id);
    if (temp.valid && parseFloat(p.temperature) > 99.6)
      feverPatients.push(p.patient_id);
  }

  const results = {
    high_risk_patients: highRisk,
    fever_patients: feverPatients,
    data_quality_issues: dataQuality,
  };

  console.log("Submitting results...");
  const submitRes = await fetch(`${BASE_URL}/submit-assessment`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": API_KEY,
    },
    body: JSON.stringify(results),
  });

  const response = await submitRes.json();
  console.log("Assessment Results:", JSON.stringify(response, null, 2));
}

// ---------------- RUN ----------------
runAssessment().catch((err) => console.error("Error running assessment:", err));
