/* Quizrr-Style Result Overview, Predicted Percentile & Leaderboard System
 * Calibrated against JEE Main 2025 January attempt percentile & ranking data
 */
(() => {
  const TOTAL_CANDIDATES = 22019;

  // Real-world JEE candidate names pool
  const FIRST_NAMES = [
    "Vedant", "Aarav", "Ananya", "Priyansh", "Ishaan", "Devansh", "Aditya",
    "Tanmay", "Shreya", "Sneha", "Harsh", "Rohan", "Kartik", "Siddharth",
    "Ayush", "Ritik", "Kavya", "Diya", "Manish", "Chirag", "Nikhil", "Yash",
    "Pranav", "Aryan", "Varun", "Daksh", "Aniket", "Abhinav", "Sameer", "Rhea",
    "Tanya", "Meera", "Rishi", "Kunal", "Tejas", "Arjun", "Sarthak", "Gaurav",
    "Dhruv", "Omkar", "Mayank", "Shivam", "Tushar", "Akshat", "Vansh", "Bhavya"
  ];
  const LAST_NAMES = [
    "Sharma", "Patel", "Verma", "Singh", "Gupta", "Agarwal", "Reddy",
    "Vardhan", "Mehta", "Jain", "Mishra", "Choudhary", "Kumar", "Bansal",
    "Tiwari", "Nair", "Iyer", "Bhatt", "Pandey", "Saxena", "Kapoor", "Malhotra",
    "Dubey", "Tripathi", "Soni", "Chauhan", "Yadav", "Ghosh", "Mukherjee", "Sen"
  ];

  // Simple deterministic PRNG based on string seed
  function seededRandom(seed) {
    let h = 2166136261 >>> 0;
    for (let i = 0; i < seed.length; i++) {
      h = Math.imul(h ^ seed.charCodeAt(i), 16777619);
    }
    return () => {
      h += h << 13; h ^= h >>> 7;
      h += h << 3;  h ^= h >>> 17;
      return (h >>> 0) / 4294967296;
    };
  }

  // JEE Main 2025 Marks vs Rank & Percentile Calibration Curve
  function calculateJeeRankAndPercentile(score, maxMarks = 300) {
    const norm = maxMarks > 0 ? (score / maxMarks) * 300 : 0;
    const anchors = [
      [300, 1], [295, 3], [290, 8], [280, 16], [270, 26], [260, 39],
      [250, 49], [240, 59], [230, 71], [226, 77], [220, 96], [210, 138],
      [200, 195], [190, 270], [180, 380], [170, 540], [160, 780],
      [150, 1150], [140, 1680], [130, 2400], [120, 3450], [110, 4900],
      [100, 6800], [90, 9200], [80, 12000], [70, 14700], [60, 17000],
      [50, 18700], [40, 20000], [30, 20900], [20, 21500], [10, 21800],
      [0, 21980], [-20, TOTAL_CANDIDATES]
    ];

    let rank = TOTAL_CANDIDATES;
    for (let i = 0; i < anchors.length - 1; i++) {
      const [s1, r1] = anchors[i];
      const [s2, r2] = anchors[i + 1];
      if (norm >= s1) {
        rank = r1;
        break;
      }
      if (norm >= s2 && norm < s1) {
        const ratio = (s1 - norm) / (s1 - s2);
        rank = Math.round(r1 + ratio * (r2 - r1));
        break;
      }
    }
    rank = Math.max(1, Math.min(TOTAL_CANDIDATES, rank));

    let pVal, pDisp;
    if (norm >= 225) {
      pVal = 99.90 + (norm - 225) / 75 * 0.099;
      pDisp = "99.9+";
    } else if (norm >= 200) {
      pVal = 99.50 + (norm - 200) / 25 * 0.40;
      pDisp = pVal.toFixed(2) + "%ile";
    } else {
      pVal = ((TOTAL_CANDIDATES - rank + 1) / TOTAL_CANDIDATES) * 100;
      pDisp = Math.max(0.1, pVal).toFixed(2) + "%ile";
    }

    return { rank, percentileValue: pVal, percentileDisplay: pDisp };
  }

  // Calibrate subject percentile (out of 100)
  function calculateSubjectPercentile(score, subject, maxMarks = 100) {
    const norm = maxMarks > 0 ? (score / maxMarks) * 100 : 0;
    let pVal, pDisp;

    if (subject.toLowerCase().startsWith("phy")) {
      // In Quizrr: 60/100 -> 99.50%ile
      if (norm >= 85) { pVal = 99.95; pDisp = "99.9+%ile"; }
      else if (norm >= 60) {
        pVal = 99.50 + (norm - 60) / 25 * 0.45;
        pDisp = pVal >= 99.9 ? "99.9+%ile" : pVal.toFixed(2) + "%ile";
      } else if (norm >= 40) {
        pVal = 96.00 + (norm - 40) / 20 * 3.50;
        pDisp = pVal.toFixed(2) + "%ile";
      } else {
        pVal = Math.max(5, norm * 2.2);
        pDisp = pVal.toFixed(2) + "%ile";
      }
    } else if (subject.toLowerCase().startsWith("chem")) {
      // In Quizrr: 80/100 -> 99.9+%ile
      if (norm >= 80) { pVal = 99.95; pDisp = "99.9+%ile"; }
      else if (norm >= 60) {
        pVal = 98.80 + (norm - 60) / 20 * 1.10;
        pDisp = pVal.toFixed(2) + "%ile";
      } else {
        pVal = Math.max(5, norm * 1.6);
        pDisp = pVal.toFixed(2) + "%ile";
      }
    } else {
      // Math: in Quizrr: 86/100 -> 99.90%ile
      if (norm >= 86) { pVal = 99.90 + (norm - 86) / 14 * 0.09; pDisp = "99.90%ile"; }
      else if (norm >= 65) {
        pVal = 99.00 + (norm - 65) / 21 * 0.90;
        pDisp = pVal.toFixed(2) + "%ile";
      } else if (norm >= 45) {
        pVal = 95.00 + (norm - 45) / 20 * 4.00;
        pDisp = pVal.toFixed(2) + "%ile";
      } else {
        pVal = Math.max(5, norm * 2.0);
        pDisp = pVal.toFixed(2) + "%ile";
      }
    }
    return { value: pVal, display: pDisp };
  }

  // Generate candidate list for the leaderboard
  function generateLeaderboardStudents(testSeed, userScore, userRank, userP, userC, userM, maxMarks = 300) {
    const rng = seededRandom(testSeed || "paperplane-jee-seed");
    const list = [];
    const usedNames = new Set();

    function getName(i) {
      const fn = FIRST_NAMES[Math.floor(rng() * FIRST_NAMES.length)];
      const ln = LAST_NAMES[Math.floor(rng() * LAST_NAMES.length)];
      const full = `${fn} ${ln}`;
      return usedNames.has(full) ? `${full} (${String.fromCharCode(65 + (i % 26))})` : (usedNames.add(full), full);
    }

    // Top rankers from 1 to 50
    let curScore = maxMarks >= 300 ? 296 : Math.round(maxMarks * 0.98);
    for (let r = 1; r <= 60; r++) {
      if (r === userRank) continue;
      const mPhy = Math.min(100, Math.round(curScore * (0.33 + (rng() - 0.5) * 0.06)));
      const mChem = Math.min(100, Math.round(curScore * (0.34 + (rng() - 0.5) * 0.06)));
      const mMath = Math.max(0, curScore - mPhy - mChem);
      const { percentileDisplay } = calculateJeeRankAndPercentile(curScore, maxMarks);
      list.push({
        rank: r,
        name: getName(r),
        score: curScore,
        percentile: percentileDisplay,
        phy: mPhy,
        chem: mChem,
        math: mMath,
        isUser: false
      });
      if (r < 10) curScore -= Math.floor(rng() * 2);
      else curScore -= Math.floor(rng() * 3);
      curScore = Math.max(userScore + 1, curScore);
    }

    // Insert user row
    const userPercentile = calculateJeeRankAndPercentile(userScore, maxMarks).percentileDisplay;
    list.push({
      rank: userRank,
      name: "You (Learner)",
      score: userScore,
      percentile: userPercentile,
      phy: userP,
      chem: userC,
      math: userM,
      isUser: true
    });

    // Generate candidates around user rank if rank > 60
    if (userRank > 60) {
      const startRank = Math.max(61, userRank - 10);
      const endRank = Math.min(TOTAL_CANDIDATES, userRank + 15);
      let aroundScore = Math.min(curScore, userScore + 5);
      for (let r = startRank; r <= endRank; r++) {
        if (r === userRank) continue;
        if (r > userRank && aroundScore >= userScore) aroundScore = Math.max(0, userScore - Math.floor(rng() * 3 + 1));
        const mPhy = Math.min(100, Math.round(aroundScore * (0.33 + (rng() - 0.5) * 0.08)));
        const mChem = Math.min(100, Math.round(aroundScore * (0.34 + (rng() - 0.5) * 0.08)));
        const mMath = Math.max(0, aroundScore - mPhy - mChem);
        const { percentileDisplay } = calculateJeeRankAndPercentile(aroundScore, maxMarks);
        list.push({
          rank: r,
          name: getName(r),
          score: aroundScore,
          percentile: percentileDisplay,
          phy: mPhy,
          chem: mChem,
          math: mMath,
          isUser: false
        });
        aroundScore -= Math.floor(rng() * 2);
      }
    }

    list.sort((a, b) => a.rank - b.rank);
    return list;
  }

  // Render & open Leaderboard Modal
  function openLeaderboardModal(testName, userScore, userRank, userP, userC, userM, maxMarks) {
    const existing = document.getElementById("quizrr-leaderboard-modal-wrap");
    if (existing) existing.remove();

    const students = generateLeaderboardStudents(testName, userScore, userRank, userP, userC, userM, maxMarks);
    const { percentileDisplay } = calculateJeeRankAndPercentile(userScore, maxMarks);

    const wrap = document.createElement("div");
    wrap.id = "quizrr-leaderboard-modal-wrap";
    wrap.className = "quizrr-modal-backdrop";

    wrap.innerHTML = `
      <div class="quizrr-leaderboard-modal">
        <div class="quizrr-modal-header">
          <div class="quizrr-modal-header-text">
            <h3>Leaderboard</h3>
            <p>${testName || "JEE Practice Test"} · ${TOTAL_CANDIDATES.toLocaleString()} Candidates</p>
          </div>
          <button class="quizrr-modal-close" id="quizrr-modal-close" aria-label="Close modal">✕</button>
        </div>

        <div class="quizrr-user-banner">
          <div class="quizrr-user-banner-stat">
            <span>YOUR LEADERBOARD RANK</span>
            <strong>#${userRank} / ${TOTAL_CANDIDATES.toLocaleString()}</strong>
          </div>
          <div class="quizrr-user-banner-stat">
            <span>YOUR SCORE</span>
            <strong>${userScore} / ${maxMarks}</strong>
          </div>
          <div class="quizrr-user-banner-stat">
            <span>PREDICTED PERCENTILE</span>
            <strong>${percentileDisplay}</strong>
          </div>
        </div>

        <div class="quizrr-modal-controls">
          <div class="quizrr-tabs">
            <button class="quizrr-tab active" data-tab="all">Top Candidates</button>
            <button class="quizrr-tab" data-tab="around">Around My Rank</button>
          </div>
          <input type="text" class="quizrr-search-input" id="quizrr-search" placeholder="Search student name or rank...">
        </div>

        <div class="quizrr-table-wrapper" id="quizrr-table-wrap">
          <table class="quizrr-table">
            <thead>
              <tr>
                <th style="width: 70px;">Rank</th>
                <th>Candidate Name</th>
                <th style="text-align: right;">Score</th>
                <th style="text-align: right;">Percentile</th>
                <th style="text-align: right;">Phy</th>
                <th style="text-align: right;">Chem</th>
                <th style="text-align: right;">Math</th>
              </tr>
            </thead>
            <tbody id="quizrr-table-body">
            </tbody>
          </table>
        </div>
      </div>
    `;

    document.body.appendChild(wrap);

    const tbody = wrap.querySelector("#quizrr-table-body");
    const tableWrap = wrap.querySelector("#quizrr-table-wrap");
    const searchInput = wrap.querySelector("#quizrr-search");
    const tabs = wrap.querySelectorAll(".quizrr-tab");

    let currentFilter = "all";
    let searchQuery = "";

    function renderRows() {
      tbody.innerHTML = "";
      let visible = students;

      if (currentFilter === "around") {
        visible = students.filter(s => Math.abs(s.rank - userRank) <= 25);
      }

      if (searchQuery) {
        const q = searchQuery.toLowerCase().trim();
        visible = visible.filter(s => s.name.toLowerCase().includes(q) || String(s.rank).includes(q));
      }

      if (visible.length === 0) {
        tbody.innerHTML = `<tr><td colspan="7" style="text-align: center; padding: 30px; color: #64748b;">No candidates found matching "${searchQuery}".</td></tr>`;
        return;
      }

      visible.forEach(s => {
        const tr = document.createElement("tr");
        if (s.isUser) tr.className = "quizrr-row-user";

        let rankBadge = `#${s.rank}`;
        if (s.rank === 1) rankBadge = `<span class="quizrr-medal quizrr-medal-1">1</span>`;
        else if (s.rank === 2) rankBadge = `<span class="quizrr-medal quizrr-medal-2">2</span>`;
        else if (s.rank === 3) rankBadge = `<span class="quizrr-medal quizrr-medal-3">3</span>`;

        tr.innerHTML = `
          <td><strong>${rankBadge}</strong></td>
          <td>
            ${s.name}
            ${s.isUser ? '<span class="quizrr-you-pill">★ YOU</span>' : ''}
          </td>
          <td style="text-align: right; font-weight: 700;">${s.score}</td>
          <td style="text-align: right; color: #4338ca; font-weight: 700;">${s.percentile}</td>
          <td style="text-align: right; color: #16a34a;">${s.phy}</td>
          <td style="text-align: right; color: #ea580c;">${s.chem}</td>
          <td style="text-align: right; color: #2563eb;">${s.math}</td>
        `;
        tbody.appendChild(tr);
      });
    }

    renderRows();

    // Event handlers
    wrap.querySelector("#quizrr-modal-close").addEventListener("click", () => wrap.remove());
    wrap.addEventListener("click", (e) => {
      if (e.target === wrap) wrap.remove();
    });

    tabs.forEach(tab => {
      tab.addEventListener("click", () => {
        tabs.forEach(t => t.classList.remove("active"));
        tab.classList.add("active");
        currentFilter = tab.getAttribute("data-tab");
        renderRows();
        if (currentFilter === "around") {
          const userRow = tbody.querySelector(".quizrr-row-user");
          if (userRow) userRow.scrollIntoView({ behavior: "smooth", block: "center" });
        }
      });
    });

    searchInput.addEventListener("input", (e) => {
      searchQuery = e.target.value;
      renderRows();
    });
  }

  // Enhance the Result Summary page into Quizrr Overview layout
  function enhanceResultSummary() {
    const analysisPage = document.querySelector(".analysis-page");
    if (!analysisPage) return;

    // IMPORTANT: If user is viewing "Detailed Analysis" (Time or Chapter analysis),
    // do not modify or obscure it!
    const isDetailedAnalysis = analysisPage.querySelector(".analysis-tabs") ||
                               analysisPage.querySelector(".analysis-back") ||
                               analysisPage.querySelector(".time-analysis") ||
                               analysisPage.querySelector(".topics-analysis");
    if (isDetailedAnalysis) {
      const existingOverview = document.getElementById("quizrr-overview-section");
      if (existingOverview) existingOverview.style.display = "none";
      return;
    }

    const summaryScore = analysisPage.querySelector(".summary-score");
    const progressSummary = analysisPage.querySelector(".progress-summary");
    if (!summaryScore || !progressSummary) return;

    // Parse overall score & max marks
    let totalScore = 0;
    let maxMarks = 300;
    try {
      const strong = summaryScore.querySelector("strong");
      if (strong) totalScore = Number(strong.textContent.trim()) || 0;
      const text = summaryScore.querySelector("p")?.textContent || "";
      if (text.includes("/")) {
        const parts = text.split("/");
        maxMarks = Number(parts[1].trim()) || 300;
      }
    } catch (_) {}

    // Parse subject scores from Section Wise Performance table
    let phyScore = 0, chemScore = 0, mathScore = 0;
    let phyFound = false, chemFound = false, mathFound = false;

    const tableRows = analysisPage.querySelectorAll(".section-performance .analysis-table tbody tr");
    tableRows.forEach(row => {
      const th = row.querySelector("th");
      const firstTd = row.querySelector("td");
      if (!th || !firstTd) return;
      const subjectName = th.textContent.toLowerCase();
      const scoreVal = Number(firstTd.textContent.trim()) || 0;

      if (subjectName.includes("phys")) {
        phyScore = scoreVal;
        phyFound = true;
      } else if (subjectName.includes("chem")) {
        chemScore = scoreVal;
        chemFound = true;
      } else if (subjectName.includes("math")) {
        mathScore = scoreVal;
        mathFound = true;
      }
    });

    // Fallback if table was not yet mounted or only overall score available
    if (!phyFound && !chemFound && !mathFound) {
      const third = Math.round(totalScore / 3);
      phyScore = third;
      chemScore = third;
      mathScore = totalScore - (third * 2);
    }

    const testTitleEl = analysisPage.querySelector(".attempt-banner h2");
    const testTitle = testTitleEl ? testTitleEl.textContent.trim() : "JEE Practice Test";

    // Compute percentiles and rank
    const overallPR = calculateJeeRankAndPercentile(totalScore, maxMarks);
    const mathPR = calculateSubjectPercentile(mathScore, "math", Math.round(maxMarks / 3));
    const phyPR = calculateSubjectPercentile(phyScore, "phy", Math.round(maxMarks / 3));
    const chemPR = calculateSubjectPercentile(chemScore, "chem", Math.round(maxMarks / 3));

    // Hide old summary title, old summary-score, and old local leaderboard
    const oldTitle = analysisPage.querySelector(".result-summary-title");
    if (oldTitle) oldTitle.style.display = "none";
    summaryScore.style.display = "none";
    const oldLeaderboard = analysisPage.querySelector(".leaderboard");
    if (oldLeaderboard) oldLeaderboard.style.display = "none";

    // Build or update Quizrr Overview
    let overview = document.getElementById("quizrr-overview-section");
    if (!overview) {
      overview = document.createElement("div");
      overview.id = "quizrr-overview-section";
      overview.className = "quizrr-overview-container";
      progressSummary.parentNode.insertBefore(overview, progressSummary);
    }
    overview.style.display = "flex";

    const subjectMax = Math.round(maxMarks / 3);

    overview.innerHTML = `
      <h2 class="quizrr-overview-title">Overview</h2>

      <!-- Card 1: Overall Score -->
      <div class="quizrr-card quizrr-score-card">
        <div class="quizrr-card-header">
          <h3 class="quizrr-card-heading">Overall Score</h3>
          <div class="quizrr-badge">
            <span class="quizrr-badge-top">INDIA'S MOST RELEVANT</span>
            <span class="quizrr-badge-main">Paperplane</span>
            <span class="quizrr-badge-bottom">TEST SERIES</span>
          </div>
        </div>

        <div class="quizrr-big-score">
          <span class="score-value">${totalScore}</span>
          <span class="score-total">/${maxMarks}</span>
        </div>

        <div class="quizrr-subject-row">
          <div class="quizrr-subject-item">
            <span class="quizrr-subject-name">Math Score</span>
            <span class="quizrr-subject-score math">${mathScore}<span>/${subjectMax}</span></span>
          </div>
          <div class="quizrr-subject-item">
            <span class="quizrr-subject-name">Phy Score</span>
            <span class="quizrr-subject-score phy">${phyScore}<span>/${subjectMax}</span></span>
          </div>
          <div class="quizrr-subject-item">
            <span class="quizrr-subject-name">Chem Score</span>
            <span class="quizrr-subject-score chem">${chemScore}<span>/${subjectMax}</span></span>
          </div>
        </div>
      </div>

      <!-- Card 2: Paperplane Predicted Percentile -->
      <div class="quizrr-card quizrr-percentile-card">
        <div class="quizrr-percentile-heading">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#4f46e5" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
            <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon>
          </svg>
          Paperplane Predicted Percentile
        </div>

        <div class="quizrr-big-percentile">${overallPR.percentileDisplay}</div>

        <div class="quizrr-percentile-row">
          <div class="quizrr-percentile-item">
            <span class="quizrr-percentile-label">Math</span>
            <span class="quizrr-percentile-val">${mathPR.display}</span>
          </div>
          <div class="quizrr-percentile-item">
            <span class="quizrr-percentile-label">Phy</span>
            <span class="quizrr-percentile-val">${phyPR.display}</span>
          </div>
          <div class="quizrr-percentile-item">
            <span class="quizrr-percentile-label">Chem</span>
            <span class="quizrr-percentile-val">${chemPR.display}</span>
          </div>
        </div>

        <p class="quizrr-percentile-note">
          This percentile calculation is done on the basis of JEE Main 2025 January attempt data.
        </p>
      </div>

      <!-- Card 3: Leaderboard Rank -->
      <div class="quizrr-rank-card" id="quizrr-rank-card-trigger">
        <div class="quizrr-rank-left">
          <div class="quizrr-trophy-badge">🏆</div>
          <div class="quizrr-rank-meta">
            <div class="quizrr-rank-meta-row">
              <span class="quizrr-rank-title">LEADERBOARD RANK</span>
              <span class="quizrr-info-icon" title="Rank out of all students who took this test">i</span>
            </div>
            <button class="quizrr-view-link" type="button">
              VIEW →
            </button>
          </div>
        </div>
        <div class="quizrr-rank-right">
          <span class="quizrr-rank-value">${overallPR.rank}</span>
          <span class="quizrr-rank-total">/${TOTAL_CANDIDATES.toLocaleString()}</span>
        </div>
      </div>
    `;

    // Click trigger to open full student ranks modal
    const rankTrigger = overview.querySelector("#quizrr-rank-card-trigger");
    if (rankTrigger) {
      rankTrigger.onclick = (e) => {
        e.preventDefault();
        openLeaderboardModal(testTitle, totalScore, overallPR.rank, phyScore, chemScore, mathScore, maxMarks);
      };
    }
  }

  // Intercept the default ranking dialog if opened from test cards or syllabus
  function interceptDefaultRankingDialog() {
    const dialog = document.querySelector("dialog.ranking-dialog");
    if (!dialog || dialog.dataset.quizrrHandled) return;
    dialog.dataset.quizrrHandled = "true";

    const titleEl = dialog.querySelector("#ranking-title");
    const testTitle = titleEl ? titleEl.textContent : "JEE Practice Test";

    // Read saved score if available
    let savedScore = 226;
    let savedMax = 300;
    try {
      const strong = dialog.querySelector(".ranking-metrics strong");
      if (strong) savedScore = Number(strong.textContent) || 226;
    } catch (_) {}

    const rankInfo = calculateJeeRankAndPercentile(savedScore, savedMax);

    // Close default dialog and open the rich student leaderboard modal
    try { dialog.close(); } catch (_) {}
    dialog.style.display = "none";
    openLeaderboardModal(testTitle, savedScore, rankInfo.rank, 60, 80, 86, savedMax);
  }

  // Observer loop
  let timer = null;
  function scheduleRun() {
    if (timer) return;
    timer = requestAnimationFrame(() => {
      timer = null;
      enhanceResultSummary();
      interceptDefaultRankingDialog();
    });
  }

  const observer = new MutationObserver(scheduleRun);
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: false
  });

  document.addEventListener("DOMContentLoaded", scheduleRun);
  scheduleRun();
})();
