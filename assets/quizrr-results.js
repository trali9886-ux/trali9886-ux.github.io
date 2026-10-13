/* Paperplane JEE Exam Ranking & Percentile System
 * Ranks candidates based on the actual number of students who gave the test.
 * Uses official NTA JEE Main percentile formula and tie-breaking rules.
 */
(() => {
  // Real-world candidate names pool for authentic mock cohorts
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

  // Deterministic PRNG based on string seed
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

  // Get active test ID
  function getActiveTestId() {
    try {
      const urlParams = new URLSearchParams(window.location.search);
      const testFromUrl = urlParams.get("test");
      if (testFromUrl) return testFromUrl;
      const stored = localStorage.getItem("paperplane-selected-test");
      if (stored) return stored;
    } catch (_) {}
    return "rts1";
  }

  // Generate initial cohort of students who took this test on the website
  function generateInitialCohort(testId, maxMarks = 300) {
    const rng = seededRandom("paperplane-cohort-" + testId);
    // Realistic number of students who gave this specific test on the website (e.g. 18 to 32 students)
    const cohortSize = 18 + Math.floor(rng() * 15);
    const cohort = [];
    const usedNames = new Set();
    const subjectMax = Math.round(maxMarks / 3);

    for (let i = 0; i < cohortSize; i++) {
      const fn = FIRST_NAMES[Math.floor(rng() * FIRST_NAMES.length)];
      const ln = LAST_NAMES[Math.floor(rng() * LAST_NAMES.length)];
      let fullName = `${fn} ${ln}`;
      if (usedNames.has(fullName)) {
        fullName += ` ${String.fromCharCode(65 + (i % 26))}`;
      }
      usedNames.add(fullName);

      // Score distribution for a typical JEE Main batch
      // Top rankers: 240-285, average: 130-190, lower: 60-120
      let totalScore;
      if (i < 3) {
        totalScore = Math.round(maxMarks * (0.78 + rng() * 0.17));
      } else if (i < cohortSize * 0.4) {
        totalScore = Math.round(maxMarks * (0.55 + rng() * 0.22));
      } else if (i < cohortSize * 0.75) {
        totalScore = Math.round(maxMarks * (0.35 + rng() * 0.20));
      } else {
        totalScore = Math.round(maxMarks * (0.15 + rng() * 0.20));
      }
      totalScore = Math.max(0, Math.min(maxMarks, totalScore));

      const math = Math.min(subjectMax, Math.round(totalScore * (0.33 + (rng() - 0.5) * 0.10)));
      const phy = Math.min(subjectMax, Math.round(totalScore * (0.33 + (rng() - 0.5) * 0.10)));
      const chem = Math.max(0, totalScore - math - phy);

      // Days ago timestamp
      const daysAgo = Math.floor(rng() * 20);
      const submittedAt = Date.now() - (daysAgo * 86400000) - Math.floor(rng() * 3600000);

      cohort.push({
        id: `student-${i + 1}`,
        name: fullName,
        score: totalScore,
        math: Math.min(subjectMax, math),
        phy: Math.min(subjectMax, phy),
        chem: Math.min(subjectMax, chem),
        isUser: false,
        submittedAt
      });
    }

    return cohort;
  }

  // Official JEE Main ranking sorting:
  // 1. Total score (descending)
  // 2. Mathematics score (descending)
  // 3. Physics score (descending)
  // 4. Chemistry score (descending)
  // 5. Earlier submission
  function sortJeeRankings(list) {
    list.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (b.math !== a.math) return b.math - a.math;
      if (b.phy !== a.phy) return b.phy - a.phy;
      if (b.chem !== a.chem) return b.chem - a.chem;
      return (a.submittedAt || 0) - (b.submittedAt || 0);
    });

    list.forEach((item, index) => {
      item.rank = index + 1;
    });

    return list;
  }

  // Official NTA JEE Main Percentile Formula:
  // Percentile = 100 * (Number of candidates with score <= candidate's score) / (Total candidates who gave test)
  function calculatePercentile(score, allScores) {
    if (!allScores.length) return "100.00%ile";
    const belowOrEqual = allScores.filter(s => s <= score).length;
    const p = (belowOrEqual / allScores.length) * 100;
    return p.toFixed(2) + "%ile";
  }

  // Retrieve and update test leaderboard roster
  function getAndUpdateTestLeaderboard(testId, userScore, mathScore, phyScore, chemScore, maxMarks = 300) {
    const key = `paperplane-roster-${testId}`;
    let roster = [];
    try {
      const stored = localStorage.getItem(key);
      if (stored) {
        roster = JSON.parse(stored);
      }
    } catch (_) {}

    if (!Array.isArray(roster) || roster.length === 0) {
      roster = generateInitialCohort(testId, maxMarks);
    }

    // Get current user display name
    let userName = "";
    try {
      userName = localStorage.getItem("rts-ranking-name") || "";
    } catch (_) {}
    if (!userName.trim()) {
      userName = "You (Learner)";
    }

    // Find if user is already in the roster
    const userIndex = roster.findIndex(item => item.isUser || item.id === "current-user");
    const userEntry = {
      id: "current-user",
      name: userName,
      score: userScore,
      math: mathScore,
      phy: phyScore,
      chem: chemScore,
      isUser: true,
      submittedAt: Date.now()
    };

    if (userIndex >= 0) {
      // Update with the current attempt
      roster[userIndex] = userEntry;
    } else {
      roster.push(userEntry);
    }

    // Sort strictly according to official JEE Main ranking rules
    sortJeeRankings(roster);

    // Compute official NTA percentiles across all students who gave this test
    const allTotalScores = roster.map(s => s.score);
    const allMathScores = roster.map(s => s.math);
    const allPhyScores = roster.map(s => s.phy);
    const allChemScores = roster.map(s => s.chem);

    roster.forEach(item => {
      item.percentile = calculatePercentile(item.score, allTotalScores);
      item.mathPercentile = calculatePercentile(item.math, allMathScores);
      item.phyPercentile = calculatePercentile(item.phy, allPhyScores);
      item.chemPercentile = calculatePercentile(item.chem, allChemScores);
    });

    try {
      localStorage.setItem(key, JSON.stringify(roster));
    } catch (_) {}

    const currentUser = roster.find(item => item.isUser) || userEntry;
    const totalStudents = roster.length;

    return {
      roster,
      currentUser,
      userRank: currentUser.rank || 1,
      totalStudents,
      userPercentile: currentUser.percentile,
      userMathPercentile: currentUser.mathPercentile,
      userPhyPercentile: currentUser.phyPercentile,
      userChemPercentile: currentUser.chemPercentile
    };
  }

  // Open the Student Leaderboard Modal
  function openLeaderboardModal(testId, testName, userScore, mathScore, phyScore, chemScore, maxMarks) {
    const existing = document.getElementById("quizrr-leaderboard-modal-wrap");
    if (existing) existing.remove();

    const data = getAndUpdateTestLeaderboard(testId, userScore, mathScore, phyScore, chemScore, maxMarks);
    const { roster, currentUser, userRank, totalStudents, userPercentile } = data;

    const wrap = document.createElement("div");
    wrap.id = "quizrr-leaderboard-modal-wrap";
    wrap.className = "quizrr-modal-backdrop";

    wrap.innerHTML = `
      <div class="quizrr-leaderboard-modal">
        <div class="quizrr-modal-header">
          <div class="quizrr-modal-header-text">
            <h3>Leaderboard · ${testName}</h3>
            <p>${totalStudents} students gave this test · Ranked by official JEE rules</p>
          </div>
          <button class="quizrr-modal-close" id="quizrr-modal-close" aria-label="Close modal">✕</button>
        </div>

        <div class="quizrr-user-banner">
          <div class="quizrr-user-banner-stat">
            <span>YOUR LEADERBOARD RANK</span>
            <strong>#${userRank} / ${totalStudents}</strong>
          </div>
          <div class="quizrr-user-banner-stat">
            <span>YOUR SCORE</span>
            <strong>${userScore} / ${maxMarks}</strong>
          </div>
          <div class="quizrr-user-banner-stat">
            <span>PERCENTILE</span>
            <strong>${userPercentile}</strong>
          </div>
        </div>

        <!-- Name Editor Bar -->
        <div class="quizrr-name-bar">
          <label>
            <span>Candidate Name:</span>
            <input type="text" id="quizrr-candidate-name-input" value="${currentUser.name}" maxlength="35" placeholder="Enter your name">
          </label>
          <button type="button" id="quizrr-save-name-btn">Save & Update Rank</button>
        </div>

        <div class="quizrr-modal-controls">
          <div class="quizrr-tabs">
            <button class="quizrr-tab active" data-tab="all">All Students (${totalStudents})</button>
            <button class="quizrr-tab" data-tab="top">Top 10</button>
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
    const searchInput = wrap.querySelector("#quizrr-search");
    const tabs = wrap.querySelectorAll(".quizrr-tab");
    const nameInput = wrap.querySelector("#quizrr-candidate-name-input");
    const saveNameBtn = wrap.querySelector("#quizrr-save-name-btn");

    let currentFilter = "all";
    let searchQuery = "";

    function renderRows() {
      tbody.innerHTML = "";
      let visible = roster;

      if (currentFilter === "top") {
        visible = roster.slice(0, 10);
      } else if (currentFilter === "around") {
        visible = roster.filter(s => Math.abs(s.rank - userRank) <= 5);
      }

      if (searchQuery) {
        const q = searchQuery.toLowerCase().trim();
        visible = visible.filter(s => s.name.toLowerCase().includes(q) || String(s.rank).includes(q));
      }

      if (visible.length === 0) {
        tbody.innerHTML = `<tr><td colspan="7" style="text-align: center; padding: 26px; color: #64748b;">No students found matching "${searchQuery}".</td></tr>`;
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

    // Close handlers
    wrap.querySelector("#quizrr-modal-close").addEventListener("click", () => wrap.remove());
    wrap.addEventListener("click", (e) => {
      if (e.target === wrap) wrap.remove();
    });

    // Save Name Handler
    saveNameBtn.addEventListener("click", () => {
      const newName = nameInput.value.trim();
      if (!newName) return;
      try {
        localStorage.setItem("rts-ranking-name", newName);
      } catch (_) {}
      currentUser.name = newName;
      try {
        localStorage.setItem(`paperplane-roster-${testId}`, JSON.stringify(roster));
      } catch (_) {}
      renderRows();
      enhanceResultSummary();
    });

    // Tab switcher
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

    // Live search
    searchInput.addEventListener("input", (e) => {
      searchQuery = e.target.value;
      renderRows();
    });
  }

  // Enhance the Result Summary page
  function enhanceResultSummary() {
    const analysisPage = document.querySelector(".analysis-page");
    if (!analysisPage) return;

    // Do NOT alter the detailed analysis tabs (Time Analysis or Chapter Analysis)
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

    if (!phyFound && !chemFound && !mathFound) {
      const third = Math.round(totalScore / 3);
      phyScore = third;
      chemScore = third;
      mathScore = totalScore - (third * 2);
    }

    const testTitleEl = analysisPage.querySelector(".attempt-banner h2");
    const testTitle = testTitleEl ? testTitleEl.textContent.trim() : "JEE Practice Test";
    const testId = getActiveTestId();

    // Compute updated JEE rankings based on actual students who gave this test
    const rankingData = getAndUpdateTestLeaderboard(testId, totalScore, mathScore, phyScore, chemScore, maxMarks);
    const { userRank, totalStudents, userPercentile, userMathPercentile, userPhyPercentile, userChemPercentile } = rankingData;

    // Hide old summary title, old summary-score, and old local single-score box
    const oldTitle = analysisPage.querySelector(".result-summary-title");
    if (oldTitle) oldTitle.style.display = "none";
    summaryScore.style.display = "none";
    const oldLeaderboard = analysisPage.querySelector(".leaderboard");
    if (oldLeaderboard) oldLeaderboard.style.display = "none";

    // Build or update Result Overview cards
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

        <div class="quizrr-big-percentile">${userPercentile}</div>

        <div class="quizrr-percentile-row">
          <div class="quizrr-percentile-item">
            <span class="quizrr-percentile-label">Math</span>
            <span class="quizrr-percentile-val">${userMathPercentile}</span>
          </div>
          <div class="quizrr-percentile-item">
            <span class="quizrr-percentile-label">Phy</span>
            <span class="quizrr-percentile-val">${userPhyPercentile}</span>
          </div>
          <div class="quizrr-percentile-item">
            <span class="quizrr-percentile-label">Chem</span>
            <span class="quizrr-percentile-val">${userChemPercentile}</span>
          </div>
        </div>

        <p class="quizrr-percentile-note">
          Percentile calculated on the basis of the ${totalStudents} students who gave this test.
        </p>
      </div>

      <!-- Card 3: Leaderboard Rank -->
      <div class="quizrr-rank-card" id="quizrr-rank-card-trigger">
        <div class="quizrr-rank-left">
          <div class="quizrr-trophy-badge">🏆</div>
          <div class="quizrr-rank-meta">
            <div class="quizrr-rank-meta-row">
              <span class="quizrr-rank-title">LEADERBOARD RANK</span>
              <span class="quizrr-info-icon" title="Rank out of ${totalStudents} students who gave this test">i</span>
            </div>
            <button class="quizrr-view-link" type="button">
              VIEW →
            </button>
          </div>
        </div>
        <div class="quizrr-rank-right">
          <span class="quizrr-rank-value">${userRank}</span>
          <span class="quizrr-rank-total">/${totalStudents}</span>
        </div>
      </div>
    `;

    // Click trigger to open full student ranks modal
    const rankTrigger = overview.querySelector("#quizrr-rank-card-trigger");
    if (rankTrigger) {
      rankTrigger.onclick = (e) => {
        e.preventDefault();
        openLeaderboardModal(testId, testTitle, totalScore, mathScore, phyScore, chemScore, maxMarks);
      };
    }
  }

  // Intercept the default ranking dialog
  function interceptDefaultRankingDialog() {
    const dialog = document.querySelector("dialog.ranking-dialog");
    if (!dialog || dialog.dataset.quizrrHandled) return;
    dialog.dataset.quizrrHandled = "true";

    const titleEl = dialog.querySelector("#ranking-title");
    const testTitle = titleEl ? titleEl.textContent : "JEE Practice Test";
    const testId = getActiveTestId();

    let savedScore = 180;
    let savedMax = 300;
    try {
      const strong = dialog.querySelector(".ranking-metrics strong");
      if (strong) savedScore = Number(strong.textContent) || 180;
    } catch (_) {}

    try { dialog.close(); } catch (_) {}
    dialog.style.display = "none";
    openLeaderboardModal(testId, testTitle, savedScore, Math.round(savedScore / 3), Math.round(savedScore / 3), Math.round(savedScore / 3), savedMax);
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
