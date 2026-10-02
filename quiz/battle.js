
const firebaseConfig = {
    apiKey: "AIzaSyAOJmK4igVb_P8cV6jLfZhFPGFmAZfVvRE",
    authDomain: "classupdates.netlify.app",
    projectId: "quiznew-30700",
    storageBucket: "quiznew-30700.firebasestorage.app",
    messagingSenderId: "107821881642",
    appId: "1:107821881642:web:7d708bda99196c85e42653",
    measurementId: "G-0B6095T5X7"
};
firebase.initializeApp(firebaseConfig);
const auth = firebase.auth();
const db = firebase.firestore();

const BATTLE_CONFIG = {
    STARTING_BALANCE: 100,
    QUESTION_COUNTS: [5, 10, 15, 50],
    TIME_PER_QUESTION_MS: 20000,
    RESOLVE_GRACE_MS: 3000,
    CORRECT_FASTEST: 4,
    CORRECT_SLOWER: 0,
    INCORRECT: -1,
    NO_ANSWER: 0,
};

let CURRENT_USER = null; 
let myProfile = null;    
let unsubMyProfile = null;


function periodKeys(date = new Date()) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return { daily: `${y}-${m}-${d}`, monthly: `${y}-${m}`, yearly: `${String(y)}` };
}

function applyCoinDelta(coinStats, delta) {
    const keys = periodKeys();
    const next = { ...coinStats };
    ['daily', 'monthly', 'yearly'].forEach(period => {
        const bucket = next[period] && next[period].periodKey === keys[period]
            ? next[period]
            : { amount: 0, periodKey: keys[period] };
        next[period] = { amount: bucket.amount + delta, periodKey: keys[period] };
    });
    return next;
}

async function ensurePublicProfile(user) {
    const ref = db.collection('public_profiles').doc(user.uid);
    const doc = await ref.get();
    if (!doc.exists) {
        const keys = periodKeys();
        await ref.set({
            uid: user.uid,
            name: user.displayName || (user.email ? user.email.split('@')[0] : 'Player'),
            photoURL: user.photoURL || null,
            balance: BATTLE_CONFIG.STARTING_BALANCE,
            coinStats: {
                daily: { amount: 0, periodKey: keys.daily },
                monthly: { amount: 0, periodKey: keys.monthly },
                yearly: { amount: 0, periodKey: keys.yearly },
            },
            battleStats: { wins: 0, losses: 0, draws: 0, totalBattles: 0 },
            createdAt: firebase.firestore.FieldValue.serverTimestamp(),
            updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
        });
    } else {
        const data = doc.data();
        const patch = {};
        if (user.displayName && data.name !== user.displayName) patch.name = user.displayName;
        if (user.photoURL && data.photoURL !== user.photoURL) patch.photoURL = user.photoURL;
        if (Object.keys(patch).length) await ref.update(patch);
    }
}

function initAuth(onReady) {
    auth.onAuthStateChanged(async (user) => {
        if (unsubMyProfile) { unsubMyProfile(); unsubMyProfile = null; }

        if (!user) {
            CURRENT_USER = null;
            myProfile = null;
            onReady(false);
            return;
        }

        CURRENT_USER = { uid: user.uid, name: user.displayName, photoURL: user.photoURL };
        try {
            await ensurePublicProfile(user);
        } catch (e) {
            console.error('❌ Battle: could not set up public profile.', e);
        }

        unsubMyProfile = db.collection('public_profiles').doc(user.uid).onSnapshot(doc => {
            if (doc.exists) {
                myProfile = doc.data();
                if (typeof onProfileChange === 'function') onProfileChange(myProfile);
            }
        });

        onReady(true);
    });
}


async function loadBattleQuizSources() {
    const snap = await db.collection('quizzes').get();
    return snap.docs
        .map(d => ({ id: d.id, ...d.data() }))
        .filter(q => Array.isArray(q.questions) && q.questions.length >= Math.min(...BATTLE_CONFIG.QUESTION_COUNTS))
        .sort((a, b) => (a.title || '').localeCompare(b.title || ''));
}

function shuffledSample(arr, n) {
    const copy = [...arr];
    for (let i = copy.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy.slice(0, n);
}

function randomBattleCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I — easy to read aloud
    let code = '';
    for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
    return code;
}

async function createBattle({ sourceQuiz, questionCount, wager }) {
    if (!CURRENT_USER) throw new Error('Not signed in.');
    if (myProfile.balance < wager) throw new Error(`You only have ${myProfile.balance} coins — can't wager ${wager}.`);

    const picked = shuffledSample(
        sourceQuiz.questions.map((q, i) => ({ ...q, qId: `Q${i + 1}` })),
        questionCount
    );

    const battleRef = db.collection('battles').doc();
    const code = randomBattleCode();

    const questionsForClients = picked.map(q => ({
        qId: q.qId,
        question: q.question,
        options: q.options,
        imageUrl: q.imageUrl || null,
    }));

    await battleRef.set({
        code,
        hostUid: CURRENT_USER.uid,
        player1: { uid: CURRENT_USER.uid, name: CURRENT_USER.name || 'Player 1', photoURL: CURRENT_USER.photoURL || null, score: 0 },
        player2: null,
        sourceQuizId: sourceQuiz.id,
        sourceQuizTitle: sourceQuiz.title || 'Quiz',
        questionCount,
        wager,
        questions: questionsForClients,
        status: 'waiting',
        currentQuestionIndex: -1,
        questionStartedAt: null,
        settled: false,
        winnerUid: null,
        createdAt: firebase.firestore.FieldValue.serverTimestamp(),
    });

    const batch = db.batch();
    picked.forEach((q, i) => {
        batch.set(battleRef.collection('answerKeys').doc(String(i)), { correctOption: q.answer });
    });
    await batch.commit();

    return { battleId: battleRef.id, code };
}
async function joinBattleByCode(code) {
    if (!CURRENT_USER) throw new Error('Not signed in.');
    const cleanCode = code.trim().toUpperCase();

    const query = await db.collection('battles')
        .where('code', '==', cleanCode)
        .where('status', '==', 'waiting')
        .limit(1)
        .get();

    if (query.empty) throw new Error('No open battle found with that code.');
    const battleRef = query.docs[0].ref;

    let result;
    await db.runTransaction(async (tx) => {
        const battleDoc = await tx.get(battleRef);
        const battle = battleDoc.data();
        if (battle.status !== 'waiting' || battle.player2) throw new Error('This battle already started or is full.');
        if (battle.player1.uid === CURRENT_USER.uid) throw new Error("You can't join your own battle.");

        const p1Ref = db.collection('public_profiles').doc(battle.player1.uid);
        const p2Ref = db.collection('public_profiles').doc(CURRENT_USER.uid);
        const p1Doc = await tx.get(p1Ref);
        const p2Doc = await tx.get(p2Ref);
        const p1Balance = p1Doc.data().balance;
        const p2Balance = p2Doc.data().balance;

        if (p1Balance < battle.wager) throw new Error('The host no longer has enough coins for this wager — battle cancelled.');
        if (p2Balance < battle.wager) throw new Error(`You need ${battle.wager} coins to join this battle.`);

        tx.update(p1Ref, { balance: p1Balance - battle.wager, updatedAt: firebase.firestore.FieldValue.serverTimestamp() });
        tx.update(p2Ref, { balance: p2Balance - battle.wager, updatedAt: firebase.firestore.FieldValue.serverTimestamp() });

        tx.update(battleRef, {
            player2: { uid: CURRENT_USER.uid, name: CURRENT_USER.name || 'Player 2', photoURL: CURRENT_USER.photoURL || null, score: 0 },
            status: 'active',
            currentQuestionIndex: 0,
            questionStartedAt: firebase.firestore.FieldValue.serverTimestamp(),
            startedAt: firebase.firestore.FieldValue.serverTimestamp(),
        });

        result = { battleId: battleRef.id };
    });

    return result;
}

function cancelWaitingBattle(battleId) {
    return db.collection('battles').doc(battleId).update({ status: 'cancelled' });
}

// =============================================================================
// LIVE BATTLE — listening, answering, scoring, advancing
// =============================================================================

function listenToBattle(battleId, onUpdate) {
    return db.collection('battles').doc(battleId).onSnapshot(doc => {
        if (doc.exists) onUpdate({ id: doc.id, ...doc.data() });
    });
}

function myPlayerKey(battle) {
    if (battle.player1.uid === CURRENT_USER.uid) return 'player1';
    if (battle.player2 && battle.player2.uid === CURRENT_USER.uid) return 'player2';
    return null;
}
function opponentOf(battle) {
    const key = myPlayerKey(battle);
    return key === 'player1' ? battle.player2 : battle.player1;
}

async function submitAnswer(battleId, qIndex, selectedOption) {
    const ref = db.collection('battles').doc(battleId).collection('answers').doc(`${CURRENT_USER.uid}_${qIndex}`);
    try {
        await ref.create({
            uid: CURRENT_USER.uid,
            qIndex,
            selectedOption, // number, or null if timed out with no selection
            answeredAt: firebase.firestore.FieldValue.serverTimestamp(),
        });
    } catch (e) {
    }
}

function watchQuestionForResolution(battle, qIndex) {
    const battleId = battle.id;
    const myUid = CURRENT_USER.uid;
    const opponent = opponentOf(battle);
    if (!opponent) return () => {};
    const oppUid = opponent.uid;
    const key = myPlayerKey(battle);

    const answersCol = db.collection('battles').doc(battleId).collection('answers');
    const deadlineMs = battle.questionStartedAt
        ? battle.questionStartedAt.toMillis() + BATTLE_CONFIG.TIME_PER_QUESTION_MS
        : Date.now() + BATTLE_CONFIG.TIME_PER_QUESTION_MS;

    let resolved = false;
    let unsubMy, unsubOpp, timeoutId;

    const cleanup = () => { if (unsubMy) unsubMy(); if (unsubOpp) unsubOpp(); if (timeoutId) clearTimeout(timeoutId); };

    const tryResolve = async () => {
        if (resolved) return;
        const myDoc = await answersCol.doc(`${myUid}_${qIndex}`).get();
        if (!myDoc.exists) return; // I haven't answered (or timed out) yet

        const oppDoc = await answersCol.doc(`${oppUid}_${qIndex}`).get();
        if (!oppDoc.exists && Date.now() < deadlineMs + BATTLE_CONFIG.RESOLVE_GRACE_MS) return; // give the opponent's write a fair chance to arrive

        resolved = true;
        cleanup();

        const keyDoc = await db.collection('battles').doc(battleId).collection('answerKeys').doc(String(qIndex)).get();
        const correctOption = keyDoc.exists ? keyDoc.data().correctOption : null;

        const myData = myDoc.data();
        const oppData = oppDoc.exists ? oppDoc.data() : null;
        const myCorrect = myData.selectedOption !== null && myData.selectedOption === correctOption;

        let delta = BATTLE_CONFIG.NO_ANSWER;
        if (myData.selectedOption === null) {
            delta = BATTLE_CONFIG.NO_ANSWER;
        } else if (!myCorrect) {
            delta = BATTLE_CONFIG.INCORRECT;
        } else {
            const oppCorrect = oppData && oppData.selectedOption !== null && oppData.selectedOption === correctOption;
            const oppWasFaster = oppCorrect && oppData.answeredAt && myData.answeredAt
                && oppData.answeredAt.toMillis() < myData.answeredAt.toMillis();
            delta = oppWasFaster ? BATTLE_CONFIG.CORRECT_SLOWER : BATTLE_CONFIG.CORRECT_FASTEST;
        }

        await db.collection('battles').doc(battleId).update({
            [`${key}.score`]: firebase.firestore.FieldValue.increment(delta),
        });

        await advanceQuestion(battleId, qIndex, battle.questions.length);
    };

    unsubMy = answersCol.doc(`${myUid}_${qIndex}`).onSnapshot(tryResolve);
    unsubOpp = answersCol.doc(`${oppUid}_${qIndex}`).onSnapshot(tryResolve);
    timeoutId = setTimeout(tryResolve, Math.max(0, deadlineMs + BATTLE_CONFIG.RESOLVE_GRACE_MS - Date.now()));

    return cleanup;
}

async function advanceQuestion(battleId, fromIndex, totalQuestions) {
    const ref = db.collection('battles').doc(battleId);
    await db.runTransaction(async (tx) => {
        const doc = await tx.get(ref);
        const data = doc.data();
        if (data.currentQuestionIndex !== fromIndex) return; // already advanced by the other client
        const nextIndex = fromIndex + 1;
        if (nextIndex >= totalQuestions) {
            tx.update(ref, { currentQuestionIndex: nextIndex, status: 'finished', finishedAt: firebase.firestore.FieldValue.serverTimestamp() });
        } else {
            tx.update(ref, { currentQuestionIndex: nextIndex, questionStartedAt: firebase.firestore.FieldValue.serverTimestamp() });
        }
    });
}


async function settleBattleIfNeeded(battleId) {
    const battleRef = db.collection('battles').doc(battleId);

    await db.runTransaction(async (tx) => {
        const battleDoc = await tx.get(battleRef);
        const battle = battleDoc.data();
        if (battle.settled) return;
        const p1Score = battle.player1.score || 0;
        const p2Score = battle.player2.score || 0;
        let winnerUid = null;
        if (p1Score > p2Score) winnerUid = battle.player1.uid;
        else if (p2Score > p1Score) winnerUid = battle.player2.uid;

        const p1Ref = db.collection('public_profiles').doc(battle.player1.uid);
        const p2Ref = db.collection('public_profiles').doc(battle.player2.uid);
        const p1Doc = await tx.get(p1Ref);
        const p2Doc = await tx.get(p2Ref);
        const p1 = p1Doc.data();
        const p2 = p2Doc.data();

        let p1WagerDelta = 0, p2WagerDelta = 0;
        if (winnerUid === battle.player1.uid) { p1WagerDelta = battle.wager; p2WagerDelta = -battle.wager; }
        else if (winnerUid === battle.player2.uid) { p2WagerDelta = battle.wager; p1WagerDelta = -battle.wager; }
        else { p1WagerDelta = battle.wager; p2WagerDelta = battle.wager; } 

        const p1NetDelta = p1Score + p1WagerDelta;
        const p2NetDelta = p2Score + p2WagerDelta;

        tx.update(p1Ref, {
            balance: p1.balance + p1NetDelta,
            coinStats: applyCoinDelta(p1.coinStats, p1NetDelta),
            battleStats: {
                wins: (p1.battleStats?.wins || 0) + (winnerUid === battle.player1.uid ? 1 : 0),
                losses: (p1.battleStats?.losses || 0) + (winnerUid === battle.player2.uid ? 1 : 0),
                draws: (p1.battleStats?.draws || 0) + (winnerUid === null ? 1 : 0),
                totalBattles: (p1.battleStats?.totalBattles || 0) + 1,
            },
            updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
        });
        tx.update(p2Ref, {
            balance: p2.balance + p2NetDelta,
            coinStats: applyCoinDelta(p2.coinStats, p2NetDelta),
            battleStats: {
                wins: (p2.battleStats?.wins || 0) + (winnerUid === battle.player2.uid ? 1 : 0),
                losses: (p2.battleStats?.losses || 0) + (winnerUid === battle.player1.uid ? 1 : 0),
                draws: (p2.battleStats?.draws || 0) + (winnerUid === null ? 1 : 0),
                totalBattles: (p2.battleStats?.totalBattles || 0) + 1,
            },
            updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
        });

        tx.update(battleRef, { settled: true, winnerUid: winnerUid || 'draw' });
    });
}

async function getExplanationForBattleQuestion(sourceQuizId, qId) {
    try {
        const doc = await db.collection('quiz_explanations').doc(`${sourceQuizId}_${qId}`).get();
        return doc.exists ? doc.data() : null;
    } catch (e) {
        return null;
    }
}

// =============================================================================
// LEADERBOARD
// =============================================================================

async function loadLeaderboard(period = 'allTime', max = 50) {
    const keys = periodKeys();

    if (period === 'allTime') {
        const snap = await db.collection('public_profiles')
            .orderBy('battleStats.wins', 'desc')
            .limit(max)
            .get();
        return snap.docs.map(d => ({ id: d.id, ...d.data(), displayAmount: d.data().battleStats?.wins || 0 }));
    }

    const field = `coinStats.${period}.amount`;
    const snap = await db.collection('public_profiles').orderBy(field, 'desc').limit(max * 2).get(); 

    return snap.docs
        .map(d => ({ id: d.id, ...d.data() }))
        .map(p => {
            const bucket = p.coinStats && p.coinStats[period];
            const isCurrent = bucket && bucket.periodKey === keys[period];
            return { ...p, displayAmount: isCurrent ? bucket.amount : 0 };
        })
        .sort((a, b) => b.displayAmount - a.displayAmount)
        .slice(0, max);
}
