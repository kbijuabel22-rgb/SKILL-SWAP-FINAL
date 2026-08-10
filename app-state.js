/**
 * SkillSwap Global State Manager & Data Binding Module
 * Single Source of Truth for user profile, Readiness level system, campus stats,
 * dynamic match calculation, theme management, and cross-page real-time sync.
 */

window.SkillSwapState = (function () {
    const STORAGE_KEY = 'skillswap_user_profile';
    const THEME_KEY = 'skillswap_theme';
    const EVENT_KEY = 'userStateUpdated';

    // Mock peers completely removed - dynamic data from Firestore only


    /**
     * Get default initial empty user profile
     */
    function getDefaultProfile() {
        return {
            uid: '',
            displayName: '',
            college: '',
            major: '',
            bio: '',
            photoURL: '',
            linkedinUrl: '',
            githubUrl: '',
            skillsOffered: [],
            skillsWanted: [],
            certifications: [],
            projects: [],
            swaps: [],
            swapsCompleted: 0,
            credits: 0,
            readinessScore: 0,
            onboardingCompleted: false
        };
    }

    /**
     * Get current user profile from localStorage
     */
    function getUserProfile() {
        try {
            const raw = localStorage.getItem(STORAGE_KEY);
            if (raw) {
                const parsed = JSON.parse(raw);
                return { ...getDefaultProfile(), ...parsed };
            }
        } catch (e) {
            console.error('Error reading user profile from localStorage:', e);
        }
        return getDefaultProfile();
    }

    /**
     * Save user profile to localStorage, broadcast event, and sync to Firestore
     */
    function saveUserProfile(updatedFields) {
        const current = getUserProfile();
        const merged = { ...current, ...updatedFields };

        if (merged.displayName && merged.bio) {
            merged.onboardingCompleted = true;
        }

        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(merged));
        } catch (e) {
            console.error('Error saving user profile to localStorage:', e);
        }

        window.dispatchEvent(new CustomEvent(EVENT_KEY, { detail: merged }));

        if (window.firebaseDb && window.firebaseAuth && window.firebaseAuth.currentUser) {
            const userUid = window.firebaseAuth.currentUser.uid;
            const docRef = window.firebaseDoc(window.firebaseDb, 'users', userUid);
            window.firebaseSetDoc(docRef, merged, { merge: true }).catch(err => {
                console.warn('Firestore background sync error:', err);
            });
        }

        return merged;
    }

    /**
     * Calculate Level Tiers based on Skill Gap Readiness Score % (0-100%)
     * 0-25%: Novice, 26-50%: Apprentice, 51-75%: Practitioner, 76-100%: Expert
     */
    function calculateReadinessLevel(score = 0) {
        const numScore = Math.max(0, Math.min(100, Math.round(Number(score) || 0)));

        let tierName = 'Novice';
        let minScore = 0;
        let maxScore = 25;

        if (numScore >= 76) {
            tierName = 'Expert';
            minScore = 76;
            maxScore = 100;
        } else if (numScore >= 51) {
            tierName = 'Practitioner';
            minScore = 51;
            maxScore = 75;
        } else if (numScore >= 26) {
            tierName = 'Apprentice';
            minScore = 26;
            maxScore = 50;
        }

        const tierRange = maxScore - minScore;
        const progressInTier = numScore - minScore;
        const progressPercent = tierRange > 0 ? Math.round((progressInTier / tierRange) * 100) : 100;

        return {
            tierName,
            score: numScore,
            minScore,
            maxScore,
            progressPercent
        };
    }

    /**
     * Calculate Profile Completeness based on 4 real conditions (25% each):
     * (a) Basic Info fully filled — Full Name, LinkedIn URL, GitHub URL, College Name, Department/Major
     * (b) At least 1 skill in Skills Offered or Skills Wanted
     * (c) At least 1 Certification or Project added
     * (d) At least 1 completed Swap
     */
    function calculateProfileCompleteness(profile = getUserProfile()) {
        const hasName = Boolean(profile.displayName && String(profile.displayName).trim());
        const hasLinkedin = Boolean(profile.linkedinUrl && String(profile.linkedinUrl).trim());
        const hasGithub = Boolean(profile.githubUrl && String(profile.githubUrl).trim());
        const hasCollege = Boolean(profile.college && String(profile.college).trim());
        const hasMajor = Boolean(profile.major && String(profile.major).trim());

        const basicInfoComplete = hasName && hasLinkedin && hasGithub && hasCollege && hasMajor;

        const hasSkillsOffered = Array.isArray(profile.skillsOffered) && profile.skillsOffered.filter(Boolean).length > 0;
        const hasSkillsWanted = Array.isArray(profile.skillsWanted) && profile.skillsWanted.filter(Boolean).length > 0;
        const skillsComplete = hasSkillsOffered || hasSkillsWanted;

        const hasCerts = Array.isArray(profile.certifications) && profile.certifications.filter(Boolean).length > 0;
        const hasProjects = Array.isArray(profile.projects) && profile.projects.filter(Boolean).length > 0;
        const portfolioComplete = hasCerts || hasProjects;

        const swapsArr = Array.isArray(profile.swaps) ? profile.swaps.filter(Boolean) : [];
        const completedSwapsCount = (Number(profile.swapsCompleted) || 0) + swapsArr.filter(s => (s.status || '').toLowerCase().includes('complet')).length;
        const swapsComplete = completedSwapsCount > 0;

        let metCount = 0;
        const missingConditions = [];

        if (basicInfoComplete) metCount++; else missingConditions.push('Complete all Basic Info fields (Name, LinkedIn, GitHub, College, Department)');
        if (skillsComplete) metCount++; else missingConditions.push('Add at least 1 skill in Skills Offered or Skills Wanted');
        if (portfolioComplete) metCount++; else missingConditions.push('Add at least 1 Certification or Project');
        if (swapsComplete) metCount++; else missingConditions.push('Complete your first skill swap session');

        const percent = metCount * 25;
        const isComplete = percent === 100;

        return {
            percent,
            isComplete,
            metCount,
            totalConditions: 4,
            basicInfoComplete,
            skillsComplete,
            portfolioComplete,
            swapsComplete,
            missingConditions,
            nextActionHint: missingConditions[0] || 'Your profile is 100% complete!'
        };
    }

    /**
     * Dynamic Match Percentage Calculation
     */
    function calculateMatchPercent(userA_offered = [], userA_wanted = [], userB_offered = [], userB_wanted = []) {
        const norm = (list) => (Array.isArray(list) ? list.map(s => String(s).trim().toLowerCase()) : []);

        const aOffered = norm(userA_offered);
        const aWanted = norm(userA_wanted);
        const bOffered = norm(userB_offered);
        const bWanted = norm(userB_wanted);

        if ((aOffered.length === 0 && aWanted.length === 0) || (bOffered.length === 0 && bWanted.length === 0)) {
            return { percent: null, isLiveMatch: false, reason: 'Add skills to see match %' };
        }

        let fwdMatched = 0;
        bWanted.forEach(w => {
            if (aOffered.some(o => o.includes(w) || w.includes(o))) fwdMatched++;
        });
        const fwdScore = bWanted.length > 0 ? (fwdMatched / bWanted.length) : 0.5;

        let revMatched = 0;
        aWanted.forEach(w => {
            if (bOffered.some(o => o.includes(w) || w.includes(o))) revMatched++;
        });
        const revScore = aWanted.length > 0 ? (revMatched / aWanted.length) : 0.5;

        const combinedScore = ((fwdScore * 0.5) + (revScore * 0.5)) * 100;
        const finalPercent = Math.max(10, Math.min(99, Math.round(combinedScore)));

        return {
            percent: finalPercent,
            isLiveMatch: finalPercent >= 60,
            reason: `${finalPercent}% Mutual Skill Match`
        };
    }

    /**
     * Campus Leaderboard strictly for current user's college only
     */
    function getCampusLeaderboard(userCollege = '', firestoreUsers = []) {
        const college = (userCollege || '').trim().toLowerCase();

        if (!college) {
            return { hasCollege: false, topUsers: [], lowData: true, collegeName: '' };
        }

        const allCandidates = [];

        // Add Firestore users sharing exact college
        firestoreUsers.forEach(u => {
            const userCol = (u.college || '').trim().toLowerCase();
            if (userCol === college || userCol.includes(college) || college.includes(userCol)) {
                allCandidates.push({
                    name: u.displayName || u.name || 'Student',
                    college: u.college,
                    score: u.readinessScore || (u.skillsOffered ? u.skillsOffered.length * 15 : 40),
                    photoURL: u.photoURL,
                    teachCount: (u.skillsOffered || u.skillsToTeach || []).length,
                    learnCount: (u.skillsWanted || u.skillsToLearn || []).length
                });
            }
        });

        // Sort descending by score/readiness and take top 3 strictly
        const topUsers = allCandidates.sort((a, b) => b.score - a.score).slice(0, 3);

        return {
            hasCollege: true,
            collegeName: userCollege,
            topUsers,
            lowData: topUsers.length < 2
        };
    }

    /**
     * Dynamic theme stylesheet injection to ensure clean light/dark transitions
     */
    function injectThemeStyleSheet() {
        if (document.getElementById('skillswap-theme-styles')) return;
        const style = document.createElement('style');
        style.id = 'skillswap-theme-styles';
        style.textContent = `
            html:not(.dark) {
                color-scheme: light !important;
                background: #f7f5fd !important;
            }
            html:not(.dark) body {
                color: #1c192c !important;
            }
            html:not(.dark) .glass-card {
                background: rgba(255, 255, 255, 0.75) !important;
                border: 1px solid rgba(0, 0, 0, 0.1) !important;
                color: #1c192c !important;
                box-shadow: 0 10px 30px rgba(0, 0, 0, 0.05) !important;
            }
            html:not(.dark) input:not([type="submit"]):not([type="button"]),
            html:not(.dark) textarea,
            html:not(.dark) select {
                background: #ffffff !important;
                color: #1c192c !important;
                border-color: rgba(0, 0, 0, 0.2) !important;
            }
            html:not(.dark) input::placeholder,
            html:not(.dark) textarea::placeholder {
                color: #777587 !important;
            }
            html:not(.dark) .text-on-surface,
            html:not(.dark) .text-on-background {
                color: #1c192c !important;
            }
            html:not(.dark) .text-on-surface-variant {
                color: #575565 !important;
            }
            html:not(.dark) .bg-surface {
                background: rgba(255, 255, 255, 0.7) !important;
            }
            html:not(.dark) .bg-surface-container {
                background: rgba(255, 255, 255, 0.85) !important;
            }
            html:not(.dark) .bg-surface-container-high {
                background: rgba(245, 243, 250, 0.95) !important;
            }
            html:not(.dark) .bg-surface-container-highest {
                background: rgba(235, 232, 243, 0.95) !important;
            }
            html:not(.dark) .bg-surface-container-lowest {
                background: #ffffff !important;
            }
            html:not(.dark) .bg-surface-container-low {
                background: rgba(255, 255, 255, 0.6) !important;
            }
            html:not(.dark) .border-outline-variant {
                border-color: rgba(0, 0, 0, 0.12) !important;
            }
        `;
        document.head.appendChild(style);
    }

    function applyThemeToBgElements(theme) {
        const canvas = document.getElementById('webgl-bg');
        const overlay = document.getElementById('webgl-overlay');
        if (theme === 'light') {
            if (canvas) canvas.style.display = 'none';
            if (overlay) {
                overlay.style.background = '#f7f5fd';
                overlay.style.display = 'block';
            }
        } else {
            if (canvas) canvas.style.display = 'block';
            if (overlay) {
                overlay.style.background = 'rgba(8,6,18,0.85)';
                overlay.style.display = 'block';
            }
        }
    }

    /**
     * Theme Management (Light/Dark Mode Toggle)
     */
    function initTheme() {
        injectThemeStyleSheet();
        const current = localStorage.getItem(THEME_KEY) || 'dark';
        if (current === 'light') {
            document.documentElement.classList.remove('dark');
            document.documentElement.style.background = '#f7f5fd';
            document.documentElement.style.colorScheme = 'light';
        } else {
            document.documentElement.classList.add('dark');
            document.documentElement.style.background = '#06040f';
            document.documentElement.style.colorScheme = 'dark';
        }
        applyThemeToBgElements(current);
    }

    function toggleTheme() {
        const isDark = document.documentElement.classList.contains('dark');
        const newTheme = isDark ? 'light' : 'dark';
        if (newTheme === 'light') {
            document.documentElement.classList.remove('dark');
            localStorage.setItem(THEME_KEY, 'light');
        } else {
            document.documentElement.classList.add('dark');
            localStorage.setItem(THEME_KEY, 'dark');
        }
        initTheme();
    }

    /**
     * Render Shared Settings Modal across all pages
     */
    function renderSettingsModal() {
        if (document.getElementById('settings-modal-overlay')) return;

        const modalHTML = `
            <div id="settings-modal-overlay" class="hidden fixed inset-0 z-50 bg-black/60 backdrop-blur-md flex items-center justify-center p-4">
                <div class="glass-card bg-surface-container-high border border-outline-variant rounded-2xl w-full max-w-md overflow-hidden shadow-2xl animate-fade-in">
                    <!-- Settings Header -->
                    <div class="px-6 py-4 border-b border-outline-variant flex items-center justify-between bg-surface-container-highest">
                        <div class="flex items-center gap-2">
                            <span class="material-symbols-outlined text-primary text-2xl">settings</span>
                            <h2 class="font-title-md text-lg font-bold text-on-surface">Settings & System Controls</h2>
                        </div>
                        <button id="close-settings-btn" class="p-1.5 rounded-full text-on-surface-variant hover:bg-surface-variant hover:text-on-surface transition-colors flex items-center justify-center">
                            <span class="material-symbols-outlined">close</span>
                        </button>
                    </div>

                    <!-- Settings Body -->
                    <div class="p-6 space-y-5">
                        <!-- Theme Toggle Section -->
                        <div class="flex items-center justify-between p-3 rounded-xl bg-surface-container-low/40 border border-outline-variant/30">
                            <div class="flex items-center gap-3">
                                <div class="w-9 h-9 rounded-full bg-primary/15 text-primary flex items-center justify-center">
                                    <span class="material-symbols-outlined">dark_mode</span>
                                </div>
                                <div>
                                    <p class="font-semibold text-sm text-on-surface">Theme Mode</p>
                                    <p class="text-xs text-on-surface-variant">Switch between Dark and Light theme</p>
                                </div>
                            </div>
                            <button id="theme-toggle-btn" class="px-3 py-1.5 rounded-xl bg-primary text-white font-badge-text text-xs font-semibold hover:opacity-90 transition-all flex items-center gap-1.5">
                                <span class="material-symbols-outlined text-sm">palette</span>
                                <span id="theme-toggle-label">Toggle</span>
                            </button>
                        </div>

                        <!-- Premium Status Badge (Static Display Only) -->
                        <div class="flex items-center justify-between p-3 rounded-xl bg-surface-container-low/40 border border-outline-variant/30">
                            <div class="flex items-center gap-3">
                                <div class="w-9 h-9 rounded-full bg-amber-500/15 text-amber-400 flex items-center justify-center">
                                    <span class="material-symbols-outlined">workspace_premium</span>
                                </div>
                                <div>
                                    <p class="font-semibold text-sm text-on-surface">Subscription Tier</p>
                                    <p class="text-xs text-on-surface-variant">SkillSwap Pro • Student Edition</p>
                                </div>
                            </div>
                            <span class="px-2.5 py-1 rounded-full bg-amber-500/20 text-amber-300 text-[11px] font-bold border border-amber-500/30">ACTIVE</span>
                        </div>

                        <!-- Wallet Balance (Static Display Only) -->
                        <div class="flex items-center justify-between p-3 rounded-xl bg-surface-container-low/40 border border-outline-variant/30">
                            <div class="flex items-center gap-3">
                                <div class="w-9 h-9 rounded-full bg-secondary-container/30 text-secondary flex items-center justify-center">
                                    <span class="material-symbols-outlined">account_balance_wallet</span>
                                </div>
                                <div>
                                    <p class="font-semibold text-sm text-on-surface">Skill Credits</p>
                                    <p class="text-xs text-on-surface-variant">Available balance for swaps</p>
                                </div>
                            </div>
                            <span id="settings-credits-display" class="font-bold text-secondary text-sm">0 Credits</span>
                        </div>
                    </div>

                    <!-- Settings Footer -->
                    <div class="px-6 py-4 border-t border-outline-variant/40 bg-surface-container-low/30 flex items-center justify-between">
                        <button id="settings-back-btn" class="px-4 py-2 rounded-xl border border-outline-variant text-on-surface text-xs font-semibold hover:bg-surface-variant transition-colors flex items-center gap-1">
                            <span class="material-symbols-outlined text-sm">arrow_back</span>
                            Back to Page
                        </button>
                        <button id="settings-logout-btn" class="px-4 py-2 rounded-xl bg-error/15 text-error border border-error/30 text-xs font-semibold hover:bg-error hover:text-white transition-colors flex items-center gap-1">
                            <span class="material-symbols-outlined text-sm">logout</span>
                            Log Out
                        </button>
                    </div>
                </div>
            </div>
        `;

        document.body.insertAdjacentHTML('beforeend', modalHTML);

        // Bind events
        const overlay = document.getElementById('settings-modal-overlay');
        const closeBtn = document.getElementById('close-settings-btn');
        const backBtn = document.getElementById('settings-back-btn');
        const themeBtn = document.getElementById('theme-toggle-btn');
        const logoutBtn = document.getElementById('settings-logout-btn');

        const closeModal = () => overlay?.classList.add('hidden');
        closeBtn?.addEventListener('click', closeModal);
        backBtn?.addEventListener('click', closeModal);
        overlay?.addEventListener('click', (e) => {
            if (e.target === overlay) closeModal();
        });

        themeBtn?.addEventListener('click', () => {
            toggleTheme();
            const label = document.getElementById('theme-toggle-label');
            if (label) label.textContent = document.documentElement.classList.contains('dark') ? 'Light Mode' : 'Dark Mode';
        });

        logoutBtn?.addEventListener('click', () => {
            if (window.firebaseAuth) {
                window.firebaseAuth.signOut().then(() => {
                    window.location.href = 'sign_in.html';
                });
            } else {
                window.location.href = 'sign_in.html';
            }
        });
    }

    function openSettingsModal() {
        renderSettingsModal();
        const overlay = document.getElementById('settings-modal-overlay');
        if (overlay) overlay.classList.remove('hidden');

        // Update credits live each time modal opens
        function updateSettingsCredits() {
            const credits = getUserProfile().credits || 0;
            const creditsEl = document.getElementById('settings-credits-display');
            if (creditsEl) {
                creditsEl.textContent = Number(credits).toLocaleString('en-IN') + ' Credits';
            }
        }
        updateSettingsCredits();
        // Keep credits badge in sync whenever profile state changes
        window.addEventListener(EVENT_KEY, updateSettingsCredits);
    }

    /**
     * Automatically update DOM header and sidebar elements across all pages
     */
    function updateHeaderAndSidebarDOM() {
        initTheme();
        renderSettingsModal();

        const profile = getUserProfile();
        const displayName = profile.displayName || profile.name || 'Student';

        // 1. Name bindings
        document.querySelectorAll('#side-nav-user-name, #top-nav-user-name, .user-display-name').forEach(el => {
            el.textContent = displayName;
        });

        // 2. Avatar bindings
        const avatarUrl = profile.photoURL || 'https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?w=150&auto=format&fit=crop&q=80';
        document.querySelectorAll('#top-nav-avatar, #sidebar-avatar, .user-avatar-img').forEach(el => {
            if (el.tagName === 'IMG') {
                el.src = avatarUrl;
                el.alt = displayName;
            }
        });

        // 3. College binding
        const sideCollege = document.getElementById('side-nav-college');
        if (sideCollege) {
            if (profile.college) {
                sideCollege.innerHTML = `<span class="truncate">${profile.college}</span>`;
                sideCollege.title = profile.college;
            } else {
                sideCollege.innerHTML = `<a href="edit_profile.html?section=basic" class="text-secondary hover:underline flex items-center gap-1"><span class="material-symbols-outlined text-[14px]">add</span> Add college</a>`;
            }
        }

        // 4. Department / Major binding
        const sideDept = document.getElementById('side-nav-dept');
        if (sideDept) {
            if (profile.major) {
                sideDept.innerHTML = `<span class="truncate">${profile.major}</span>`;
                sideDept.title = profile.major;
            } else {
                sideDept.innerHTML = `<a href="edit_profile.html?section=basic" class="text-on-surface-variant/60 hover:underline flex items-center gap-1"><span class="material-symbols-outlined text-[14px]">add</span> Add department</a>`;
            }
        }

        // 5. Level Badge binding based on Readiness Score
        const levelInfo = calculateReadinessLevel(profile.readinessScore || 0);
        document.querySelectorAll('#sidebar-level-badge, .user-level-badge').forEach(el => {
            el.textContent = levelInfo.tierName;
        });

        // Wire Hamburger Menu to open Settings modal
        document.querySelectorAll('#hamburger-btn, .hamburger-menu-trigger').forEach(btn => {
            if (!btn._settingsWired) {
                btn._settingsWired = true;
                btn.addEventListener('click', (e) => {
                    e.preventDefault();
                    openSettingsModal();
                });
            }
        });
    }

    // Subscribe to cross-tab/window updates
    window.addEventListener('storage', (e) => {
        if (e.key === STORAGE_KEY) {
            updateHeaderAndSidebarDOM();
            window.dispatchEvent(new CustomEvent(EVENT_KEY, { detail: getUserProfile() }));
        }
    });

    window.addEventListener(EVENT_KEY, () => {
        updateHeaderAndSidebarDOM();
    });

    // Auto-run on DOM ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', updateHeaderAndSidebarDOM);
    } else {
        updateHeaderAndSidebarDOM();
    }

    return {
        getUserProfile,
        saveUserProfile,
        calculateReadinessLevel,
        calculateProfileCompleteness,
        calculateMatchPercent,
        getCampusLeaderboard,
        updateHeaderAndSidebarDOM,
        openSettingsModal,
        toggleTheme,
        getMockPeers: () => [],
        EVENT_KEY
    };
})();
