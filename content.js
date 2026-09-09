(function init() {
    console.log('🚀 CF Peak Analyzer initialized!');

    const pathname = window.location.pathname;
    const parts = pathname.split('/').filter(Boolean);
    if (parts.length < 2 || parts[0] !== 'profile') return;
    const handle = parts[1];

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => injectPanel(handle));
    } else {
        injectPanel(handle);
    }
})();

const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const storageArea = (typeof browser !== 'undefined' ? browser.storage : chrome.storage).local;

function cacheKey(handle) {
    return `cf_peak_cache_${handle}`;
}

async function readCache(handle) {
    try {
        const result = await storageArea.get(cacheKey(handle));
        const entry = result[cacheKey(handle)];
        if (!entry) return null;
        const age = Date.now() - entry.timestamp;
        if (age > CACHE_TTL_MS) return null;
        return { ...entry, ageMs: age };
    } catch (err) {
        console.warn('CF Peak Analyzer: cache read failed', err);
        return null;
    }
}

async function writeCache(handle, ratings, submissions) {
    try {
        await storageArea.set({
            [cacheKey(handle)]: { timestamp: Date.now(), ratings, submissions }
        });
    } catch (err) {
        console.warn('CF Peak Analyzer: cache write failed', err);
    }
}

function formatAge(ms) {
    const mins = Math.round(ms / 60000);
    if (mins < 1) return 'just now';
    if (mins === 1) return '1 minute ago';
    return `${mins} minutes ago`;
}

function injectPanel(handle) {
    if (document.getElementById('cf-analyzer-root')) return;

    const ratingGraphBox = document.querySelector('#placeholder')?.closest('.roundbox')
        || document.querySelector('.userbox')?.closest('.roundbox')
        || document.querySelector('#pageContent');

    if (!ratingGraphBox) return;

    const container = document.createElement('div');
    container.id = 'cf-analyzer-root';
    container.className = 'cf-analyzer-box';

    container.innerHTML = `
        <div class="cf-analyzer-header">
            <h3>Peak Analyzer</h3>
            <div class="cf-analyzer-actions">
                <button id="cf-reset-zoom-btn" class="cf-btn cf-btn-secondary">Reset Zoom</button>
                <button id="cf-fetch-btn" class="cf-btn cf-btn-primary">Analyze Solves vs Peak</button>
            </div>
        </div>
        <div id="cf-status" class="cf-analyzer-status"></div>
        <div id="cf-chart-wrapper" class="cf-chart-wrapper">
            <canvas id="cfPeakChart"></canvas>
            <div class="cf-legend-hint">Scroll/pinch to zoom &middot; drag to pan &middot; blue line = rating, dots = daily max solve</div>
        </div>
    `;

    ratingGraphBox.parentNode.insertBefore(container, ratingGraphBox.nextSibling);

    let hasLoadedOnce = false;

    document.getElementById('cf-fetch-btn').addEventListener('click', () => {
        runAnalysis(handle, hasLoadedOnce);
        hasLoadedOnce = true;
    });

    document.getElementById('cf-reset-zoom-btn').addEventListener('click', () => {
        if (window.myCfChart && typeof window.myCfChart.resetZoom === 'function') {
            window.myCfChart.resetZoom();
        }
    });
}

function setStatus(text) {
    const el = document.getElementById('cf-status');
    if (el) el.textContent = text;
}

async function fetchFromApi(handle) {
    const [rRating, rStatus] = await Promise.all([
        fetch(`https://codeforces.com/api/user.rating?handle=${handle}`).then(r => r.json()),
        fetch(`https://codeforces.com/api/user.status?handle=${handle}`).then(r => r.json())
    ]);

    if (rRating.status !== 'OK' || !rRating.result.length) {
        throw new Error('NO_RATING_HISTORY');
    }
    if (rStatus.status !== 'OK') {
        throw new Error('API_ERROR');
    }

    return { ratings: rRating.result, submissions: rStatus.result };
}

async function runAnalysis(handle, forceRefresh) {
    const btn = document.getElementById('cf-fetch-btn');
    btn.disabled = true;

    try {
        let ratings, submissions;

        const cached = forceRefresh ? null : await readCache(handle);
        if (cached) {
            ({ ratings, submissions } = cached);
            btn.textContent = 'Re-Analyze';
            setStatus(`Loaded from cache (fetched ${formatAge(cached.ageMs)}). Click Re-Analyze for fresh data.`);
        } else {
            btn.textContent = 'Fetching API Data...';
            setStatus('Fetching rating history and submissions from the Codeforces API…');
            ({ ratings, submissions } = await fetchFromApi(handle));
            await writeCache(handle, ratings, submissions);
            btn.textContent = 'Re-Analyze';
            setStatus('Fetched fresh data from the Codeforces API.');
        }

        const { ratingCurvePoints, pointBorderColors, pointBorderWidths, pointRadii } = buildRatingCurve(ratings);
        const { solvePoints, solvePointColors } = buildSolvePoints(submissions, ratingCurvePoints._peakTime);

        document.getElementById('cf-chart-wrapper').style.display = 'block';
        document.getElementById('cf-reset-zoom-btn').style.display = 'inline-block';
        btn.disabled = false;

        renderChart(solvePoints, ratingCurvePoints, pointBorderColors, pointBorderWidths, pointRadii, solvePointColors);
    } catch (err) {
        console.error(err);
        btn.disabled = false;
        if (err.message === 'NO_RATING_HISTORY') {
            btn.textContent = 'No rating history found.';
            setStatus('This handle has no rated contests yet.');
        } else if (err.message === 'API_ERROR') {
            btn.textContent = 'API error, try again.';
            setStatus('Codeforces API returned an error while fetching submissions.');
        } else {
            btn.textContent = 'Error loading data!';
            setStatus('Something went wrong. Check the console for details.');
        }
    }
}

function buildRatingCurve(ratings) {
    let peakEvent = ratings[0];
    ratings.forEach(r => {
        if (r.newRating > peakEvent.newRating) peakEvent = r;
    });
    const peakTime = peakEvent.ratingUpdateTimeSeconds;

    const ratingCurvePoints = [];
    const pointBorderColors = [];
    const pointBorderWidths = [];
    const pointRadii = [];

    ratings.forEach(r => {
        const isPeak = r.ratingUpdateTimeSeconds === peakTime;
        ratingCurvePoints.push({
            x: r.ratingUpdateTimeSeconds * 1000,
            y: r.newRating,
            contest: r.contestName,
            isPeak,
            relDays: Math.round((r.ratingUpdateTimeSeconds - peakTime) / 86400.0)
        });

        if (isPeak) {
            pointBorderColors.push('#e63946'); // accent red, only for the peak
            pointBorderWidths.push(3);
            pointRadii.push(5.5);
        } else {
            pointBorderColors.push('#7fa8d9'); // light bluish, matches the curve
            pointBorderWidths.push(1);
            pointRadii.push(2.5);
        }
    });

    ratingCurvePoints._peakTime = peakTime;
    return { ratingCurvePoints, pointBorderColors, pointBorderWidths, pointRadii };
}

function buildSolvePoints(submissions, peakTime) {
    const dailyMap = new Map();
    const seenProblems = new Set();

    submissions.forEach(sub => {
        if (sub.verdict === 'OK' && sub.problem && sub.problem.rating) {
            const pKey = `${sub.problem.contestId}-${sub.problem.index}`;
            if (!seenProblems.has(pKey)) {
                seenProblems.add(pKey);

                const subDate = new Date(sub.creationTimeSeconds * 1000);
                subDate.setUTCHours(0, 0, 0, 0);
                const dayTimestamp = subDate.getTime();

                const relDays = Math.round((sub.creationTimeSeconds - peakTime) / 86400.0);
                const existing = dailyMap.get(dayTimestamp) || { maxRating: 0, count: 0, problemName: '', relDays };
                const newMax = Math.max(existing.maxRating, sub.problem.rating);
                const problemTitle = sub.problem.rating === newMax ? `${sub.problem.name} (${sub.problem.rating})` : existing.problemName;

                dailyMap.set(dayTimestamp, {
                    maxRating: newMax,
                    count: existing.count + 1,
                    problemName: problemTitle,
                    relDays
                });
            }
        }
    });

    const solvePoints = [];
    const solvePointColors = [];

    dailyMap.forEach((data, timestamp) => {
        solvePoints.push({
            x: timestamp,
            y: data.maxRating,
            count: data.count,
            problem: data.problemName,
            relDays: data.relDays
        });

        const opacity = Math.min(1.0, 0.4 + (data.count - 1) * 0.15);
        solvePointColors.push(getCFColor(data.maxRating, opacity));
    });

    return { solvePoints, solvePointColors };
}

// Official Codeforces Color Scale
function getCFColor(rating, opacity) {
    if (rating >= 3000) return `rgba(170, 0, 0, ${opacity})`;    // Legendary GM
    if (rating >= 2700) return `rgba(255, 0, 0, ${opacity})`;    // International GM
    if (rating >= 2400) return `rgba(255, 0, 0, ${opacity})`;    // GM
    if (rating >= 2300) return `rgba(255, 140, 0, ${opacity})`;  // International Master
    if (rating >= 2100) return `rgba(255, 187, 0, ${opacity})`;  // Master
    if (rating >= 1900) return `rgba(170, 0, 170, ${opacity})`;  // Candidate Master
    if (rating >= 1600) return `rgba(0, 0, 255, ${opacity})`;    // Expert
    if (rating >= 1400) return `rgba(3, 168, 158, ${opacity})`;  // Specialist
    if (rating >= 1200) return `rgba(0, 128, 0, ${opacity})`;    // Pupil
    return `rgba(128, 128, 128, ${opacity})`;                    // Newbie
}

function renderChart(solvePoints, ratingCurvePoints, pointBorderColors, pointBorderWidths, pointRadii, solvePointColors) {
    const canvas = document.getElementById('cfPeakChart');
    const ctx = canvas.getContext('2d');
    const ChartEngine = window.Chart || Chart;

    if (window.myCfChart) window.myCfChart.destroy();

    const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

    window.myCfChart = new ChartEngine(ctx, {
        type: 'scatter',
        data: {
            datasets: [
                {
                    label: 'Rating Trajectory',
                    data: ratingCurvePoints,
                    type: 'line',
                    borderColor: '#7fa8d9',
                    backgroundColor: 'rgba(127, 168, 217, 0.08)',
                    borderWidth: 2,
                    pointBackgroundColor: '#a7c4e8',
                    pointBorderColor: pointBorderColors,
                    pointBorderWidth: pointBorderWidths,
                    pointRadius: pointRadii,
                    tension: 0.15,
                    fill: false,
                    order: 1
                },
                {
                    label: 'Daily Max Solved Difficulty',
                    data: solvePoints,
                    type: 'scatter',
                    pointBackgroundColor: solvePointColors,
                    pointBorderColor: solvePointColors.map(c => typeof c === 'string' ? c.replace(/[\d.]+\)$/, '0.9)') : '#000'),
                    pointRadius: 2.5,
                    pointHoverRadius: 5,
                    order: 2
                }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: { mode: 'nearest', intersect: false },
            scales: {
                x: {
                    type: 'linear',
                    position: 'bottom',
                    title: { display: true, text: 'Timeline (Date)', font: { weight: 'bold', size: 12 } },
                    ticks: {
                        callback: value => {
                            const d = new Date(value);
                            return `${monthNames[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
                        }
                    },
                    grid: { color: '#eef1f3' }
                },
                y: {
                    min: 800,
                    max: 3500,
                    title: { display: true, text: 'Rating / Problem Difficulty', font: { weight: 'bold', size: 12 } },
                    grid: { color: '#eef1f3' }
                }
            },
            plugins: {
                zoom: {
                    limits: { x: { min: 'original', max: 'original' } },
                    pan: { enabled: true, mode: 'x' },
                    zoom: {
                        wheel: { enabled: true, speed: 0.05 },
                        pinch: { enabled: true },
                        mode: 'x'
                    }
                },
                tooltip: {
                    callbacks: {
                        title: tooltipItems => {
                            const raw = tooltipItems[0].raw;
                            if (!raw.x) return '';
                            const d = new Date(raw.x);
                            const dateStr = `${monthNames[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
                            const relStr = raw.isPeak
                                ? '★ PEAK RATING DATE ★'
                                : (raw.relDays > 0 ? `+${raw.relDays} days post-peak` : `${raw.relDays} days pre-peak`);
                            return `${dateStr} (${relStr})`;
                        },
                        label: ctx => {
                            const raw = ctx.raw;
                            if (ctx.dataset.type === 'line') {
                                return raw.isPeak
                                    ? `★ Peak Rating: ${raw.y} (${raw.contest || ''})`
                                    : `Rating: ${raw.y} (${raw.contest || ''})`;
                            }
                            return `Max solve: ${raw.y} rated (${raw.count} solves total on this day)`;
                        }
                    }
                }
            }
        }
    });

    canvas.addEventListener('pointerdown', () => canvas.classList.add('cf-grabbing'));
    window.addEventListener('pointerup', () => canvas.classList.remove('cf-grabbing'));
}
