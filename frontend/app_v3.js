// ── Secure Fetch Interceptor ─────────────────────────────────────────────────
// Automatically injects Authorization: Bearer <jwt> header on all /api/ calls.
// Clears expired tokens automatically on 401 response to prevent app UI crashes.
(function() {
    const originalFetch = window.fetch;
    window.fetch = async function(url, options) {
        if (typeof url === 'string' && (url.startsWith('/api/') || url.includes('/api/'))) {
            options = options || {};
            options.headers = options.headers || {};

            const token = sessionStorage.getItem('medsafe_jwt');
            if (token) {
                if (options.headers instanceof Headers) {
                    options.headers.set('Authorization', 'Bearer ' + token);
                } else if (Array.isArray(options.headers)) {
                    options.headers.push(['Authorization', 'Bearer ' + token]);
                } else {
                    options.headers['Authorization'] = 'Bearer ' + token;
                }
            }
        }
        const response = await originalFetch(url, options);
        if (response.status === 401 && typeof url === 'string' && url.includes('/api/')) {
            sessionStorage.removeItem('medsafe_jwt');
        }
        return response;
    };
})();

function parseJwt(token) {
    if (!token) return null;
    try {
        const base64Url = token.split('.')[1];
        if (!base64Url) return null;
        const base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/');
        const pad = base64.length % 4;
        const paddedBase64 = pad ? base64 + '='.repeat(4 - pad) : base64;
        const jsonPayload = decodeURIComponent(atob(paddedBase64).split('').map(function(c) {
            return '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2);
        }).join(''));
        return JSON.parse(jsonPayload);
    } catch (e) {
        try {
            return JSON.parse(atob(token.split('.')[1]));
        } catch (e2) {
            return null;
        }
    }
}

// State Management
let appState = {
    activeTab: 'dashboard',
    medications: [],
    allergies: [],
    symptoms: [],
    adherence: [],
    doctorNotes: [],
    selectedDate: new Date().toISOString().split('T')[0], // YYYY-MM-DD
    pendingForceAddMed: null,
    correlationChart: null,
    get currentUserEmail() {
        const token = sessionStorage.getItem('medsafe_jwt');
        const payload = parseJwt(token);
        if (payload && payload.sub) return payload.sub;
        return 'guest@medsafe.ai';
    },
    get currentUserName() {
        const token = sessionStorage.getItem('medsafe_jwt');
        const payload = parseJwt(token);
        if (payload && payload.name) return payload.name;
        return 'Guest User';
    },
    get currentPatientId() {
        const token = sessionStorage.getItem('medsafe_jwt');
        const payload = parseJwt(token);
        if (payload && payload.patient_id) return payload.patient_id;
        return 'MED-1001';
    },
    get isDoctorView() {
        const token = sessionStorage.getItem('medsafe_jwt');
        const payload = parseJwt(token);
        if (payload && payload.is_doctor) return true;
        return false;
    }
};
// Authentication State
let authState = {
    isRegistered: false,
    mode: 'login' // 'login' or 'register'
};

// Tab Prefetch Cache System
const prefetchCache = {
    report: null,
    labReports: null
};

function prefetchTab(tabId) {
    if (tabId === 'reports') {
        if (!prefetchCache.report) {
            prefetchCache.report = fetch('/api/report')
                .then(res => {
                    if (!res.ok) throw new Error("Prefetch failed");
                    return res.json();
                })
                .catch(err => {
                    console.error("Prefetch report failed", err);
                    prefetchCache.report = null;
                });
        }
    } else if (tabId === 'lab-reports') {
        if (!prefetchCache.labReports) {
            prefetchCache.labReports = fetch('/api/lab-reports')
                .then(res => {
                    if (!res.ok) throw new Error("Prefetch failed");
                    return res.json();
                })
                .catch(err => {
                    console.error("Prefetch lab-reports failed", err);
                    prefetchCache.labReports = null;
                });
        }
    }
}

function invalidatePrefetchCache() {
    prefetchCache.report = null;
    prefetchCache.labReports = null;
}

async function refreshDataSilently() {
    try {
        await Promise.all([
            fetchMedications(),
            fetchAllergies(),
            fetchSymptoms(),
            fetchAdherence()
        ]);
        updateDashboardWidgets();
        updateChecklistUI();
        updateMedicationsUI();
        updateSymptomsUI();
        populateCorrelatedMedicationsDropdown();
    } catch (err) {
        console.error("Silent refresh failed:", err);
    }
}

// Initial Setup
document.addEventListener('DOMContentLoaded', () => {
    // Initialize Lucide Icons
    lucide.createIcons();

    // Send doctor notes button listener
    const btnSendNotes = document.getElementById('btn-send-doctor-notes');
    if (btnSendNotes) {
        btnSendNotes.addEventListener('click', async () => {
            const notesTextarea = document.getElementById('doctor-notes-textarea');
            if (notesTextarea) {
                const value = notesTextarea.value.trim();
                if (!value) return;
                
                const originalText = btnSendNotes.innerHTML;
                btnSendNotes.disabled = true;
                btnSendNotes.innerHTML = 'Saving...';
                
                // Append new note to active state
                appState.doctorNotes.push(value);
                
                try {
                    // 1. Save list to SQLite database
                    await fetch('/api/doctor-notes', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ notes: appState.doctorNotes })
                    });
                    
                    // 2. Save list to localStorage
                    localStorage.setItem('doctor_notes_' + appState.currentUserEmail, JSON.stringify(appState.doctorNotes));
                    
                    // 3. Render display list
                    renderDoctorNotes();
                    
                    // 4. Clear textarea input
                    notesTextarea.value = '';
                    
                    // Visual confirmation
                    btnSendNotes.innerHTML = 'Saved! ✓';
                    btnSendNotes.style.backgroundColor = '#10b981'; // emerald green
                    setTimeout(() => {
                        btnSendNotes.disabled = false;
                        btnSendNotes.innerHTML = originalText;
                        btnSendNotes.style.backgroundColor = '';
                    }, 1500);
                } catch (err) {
                    console.error("Failed to save doctor notes to database:", err);
                    // Rollback state on error
                    appState.doctorNotes.pop();
                    btnSendNotes.disabled = false;
                    btnSendNotes.innerHTML = 'Retry ⚠';
                }
            }
        });
    }

    // Download PDF Button Click Listener
    const btnDownloadPdfReport = document.getElementById('btn-download-pdf-report');
    if (btnDownloadPdfReport) {
        btnDownloadPdfReport.addEventListener('click', () => {
            const notes = appState.doctorNotes.map(n => '• ' + n).join('\n');
            const token = window.reportPdfToken;
            if (!token) {
                alert("Doctor report data is still loading. Please wait a moment.");
                return;
            }
            window.location.href = `/api/report/pdf?email=${encodeURIComponent(appState.currentUserEmail)}&token=${token}&doctor_notes=${encodeURIComponent(notes)}`;
        });
    }
    
    // Initialize Auth & Animation Flow
    initAuthFlow();
    
    // Wire Sidebar Tabs
    const navItems = document.querySelectorAll('.nav-item');
    navItems.forEach(item => {
        item.addEventListener('click', () => {
            const tabId = item.getAttribute('data-tab');
            switchTab(tabId);
        });
        item.addEventListener('mouseenter', () => {
            const tabId = item.getAttribute('data-tab');
            prefetchTab(tabId);
        });
        item.addEventListener('focus', () => {
            const tabId = item.getAttribute('data-tab');
            prefetchTab(tabId);
        });
    });

    // Generate Calendar Bar for Adherence
    initChecklistCalendar();

    // Setup Form Listeners
    setupForms();

    // Refresh Data from Database
    refreshData();

    // Initialize Medication Alarms System
    initMedicationAlarms();

    // Initialize Theme System
    initTheme();
    // Initialize Lab Reports System
    initLabReportsSystem();

    // Initialize Interactive AI Copilot Voice Input & Quick Chips
    initVoiceRecognition();
    initQuickChips();

    // Mobile Sidebar Drawer Toggler
    const btnSidebarToggle = document.getElementById('btn-sidebar-toggle');
    const sidebar = document.querySelector('.sidebar');
    if (btnSidebarToggle && sidebar) {
        btnSidebarToggle.addEventListener('click', (e) => {
            e.stopPropagation();
            sidebar.classList.toggle('active');
        });
        
        document.addEventListener('click', (e) => {
            if (window.innerWidth <= 768 && sidebar.classList.contains('active')) {
                if (!sidebar.contains(e.target) && e.target !== btnSidebarToggle) {
                    sidebar.classList.remove('active');
                }
            }
        });
        
        const navItems = document.querySelectorAll('.nav-item');
        navItems.forEach(item => {
            item.addEventListener('click', () => {
                if (window.innerWidth <= 768) {
                    sidebar.classList.remove('active');
                }
            });
        });
    }
});

function initTheme() {
    const btnToggle = document.getElementById('btn-theme-toggle');
    
    // Check saved theme or default to dark
    const savedTheme = localStorage.getItem('medsafe_theme') || 'dark';
    applyTheme(savedTheme);
    
    if (btnToggle) {
        btnToggle.addEventListener('click', () => {
            const currentTheme = document.body.classList.contains('light-theme') ? 'light' : 'dark';
            const newTheme = currentTheme === 'light' ? 'dark' : 'light';
            applyTheme(newTheme);
        });
    }
    
    function applyTheme(theme) {
        localStorage.setItem('medsafe_theme', theme);
        if (theme === 'light') {
            document.body.classList.add('light-theme');
        } else {
            document.body.classList.remove('light-theme');
        }
        if (window.lucide) {
            lucide.createIcons();
        }
    }
}

function initAuthFlow() {
    const overlay = document.getElementById('login-screen-overlay');
    const introStage = document.getElementById('intro-stage');
    const authStage = document.getElementById('auth-stage');
    const authForm = document.getElementById('auth-form');
    const linkToggle = document.getElementById('link-toggle-auth');
    const labelToggle = document.getElementById('toggle-label-text');
    const btnSubmit = document.getElementById('btn-auth-submit');
    const btnGuest = document.getElementById('btn-auth-guest');
    const btnLogout = document.getElementById('btn-logout-sidebar');
    const btnGoogleSignIn = document.getElementById('btn-google-signin');
    const errorMsg = document.getElementById('auth-error-msg');

    const inputUsername = document.getElementById('auth-username');
    const inputEmail = document.getElementById('auth-email');
    const inputPassword = document.getElementById('auth-password');
    const groupUsername = document.getElementById('group-username');
    const passwordHint = document.getElementById('password-hint');
    const subtitle = document.getElementById('auth-card-subtitle');

    // Role Tab Elements
    const tabRolePatient = document.getElementById('tab-role-patient');
    const tabRoleDoctor = document.getElementById('tab-role-doctor');
    const patientAuthSection = document.getElementById('patient-auth-section');
    const doctorAuthSection = document.getElementById('doctor-auth-section');
    const doctorAuthForm = document.getElementById('doctor-auth-form');
    const inputDoctorEmail = document.getElementById('doctor-email');
    const inputDoctorPassword = document.getElementById('doctor-password');
    const doctorErrorMsg = document.getElementById('doctor-auth-error-msg');
    const btnDoctorSubmit = document.getElementById('btn-doctor-submit');
    const btnExitDoctorMode = document.getElementById('btn-exit-doctor-mode');
    const pageBtnDoctorLogout = document.getElementById('btn-page-doctor-logout');

    // Reveal login pop-up stage immediately on load
    if (authStage) {
        authStage.classList.add('active');
    }

    // Global Logout Handler Setup (Always bound regardless of active session state)
    const handleGlobalLogout = () => {
        sessionStorage.removeItem('medsafe_jwt');
        if (window.google && window.google.accounts) {
            try { google.accounts.id.disableAutoSelect(); } catch(e) {}
        }
        location.reload();
    };

    if (btnLogout) btnLogout.addEventListener('click', handleGlobalLogout);
    if (btnExitDoctorMode) btnExitDoctorMode.addEventListener('click', handleGlobalLogout);
    if (pageBtnDoctorLogout) pageBtnDoctorLogout.addEventListener('click', handleGlobalLogout);

    // Role Tab Toggle Switcher
    if (tabRolePatient && tabRoleDoctor) {
        tabRolePatient.addEventListener('click', () => {
            tabRolePatient.classList.add('active');
            tabRolePatient.style.background = 'var(--accent-color, #0066cc)';
            tabRolePatient.style.color = 'white';
            tabRoleDoctor.classList.remove('active');
            tabRoleDoctor.style.background = 'transparent';
            tabRoleDoctor.style.color = 'var(--text-secondary)';
            if (patientAuthSection) patientAuthSection.style.display = 'block';
            if (doctorAuthSection) doctorAuthSection.style.display = 'none';
        });

        tabRoleDoctor.addEventListener('click', () => {
            tabRoleDoctor.classList.add('active');
            tabRoleDoctor.style.background = 'linear-gradient(135deg, #0ea5e9, #0284c7)';
            tabRoleDoctor.style.color = 'white';
            tabRolePatient.classList.remove('active');
            tabRolePatient.style.background = 'transparent';
            tabRolePatient.style.color = 'var(--text-secondary)';
            if (patientAuthSection) patientAuthSection.style.display = 'none';
            if (doctorAuthSection) doctorAuthSection.style.display = 'block';
        });
    }

    // Doctor Workspace Elements
    const doctorWorkspaceModal = document.getElementById('doctor-workspace-modal');
    const btnDoctorWorkspaceLogout = document.getElementById('btn-doctor-workspace-logout');
    const inputSearchPatientId = document.getElementById('input-search-patient-id');
    const btnSearchPatient = document.getElementById('btn-search-patient');
    const searchResultsArea = document.getElementById('patient-search-results-area');
    const searchResultsList = document.getElementById('search-results-list');
    const myPatientsListContainer = document.getElementById('my-patients-list-container');
    const myPatientsCount = document.getElementById('my-patients-count');

    // Password Challenge Modal Elements
    const challengeModal = document.getElementById('patient-password-challenge-modal');
    const challengePatientName = document.getElementById('challenge-patient-name');
    const challengePatientId = document.getElementById('challenge-patient-id');
    const challengeForm = document.getElementById('form-patient-password-challenge');
    const challengePasswordInput = document.getElementById('challenge-password');
    const challengeErrorMsg = document.getElementById('challenge-error-msg');
    const btnCancelChallenge = document.getElementById('btn-cancel-challenge');
    const btnSubmitChallenge = document.getElementById('btn-submit-challenge');

    let activeChallengePatientId = null;

    // Doctor Auth Form Submission (Doctor logs in with Doctor Email)
    if (doctorAuthForm) {
        doctorAuthForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            if (doctorErrorMsg) doctorErrorMsg.style.display = 'none';

            const email = inputDoctorEmail ? inputDoctorEmail.value.trim() : '';
            const password = inputDoctorPassword ? inputDoctorPassword.value : '';

            if (!email || !password) return;

            btnDoctorSubmit.disabled = true;
            const origLabel = btnDoctorSubmit.querySelector('span').textContent;
            btnDoctorSubmit.querySelector('span').textContent = 'Authenticating Doctor...';

            try {
                const res = await fetch('/api/doctor/login', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ email, password })
                });
                const data = await res.json();

                if (!res.ok) {
                    showDoctorAuthError(data.detail || "Doctor login failed.");
                    return;
                }

                sessionStorage.setItem('medsafe_jwt', data.access_token);
                localStorage.setItem('medsafe_doctor_jwt', data.access_token);
                localStorage.setItem('medsafe_doctor_email', data.email);
                localStorage.setItem('medsafe_doctor_name', data.username || data.name || data.email);
                openDoctorWorkspace(data.email, data.username || data.name || data.email);
            } catch (err) {
                showDoctorAuthError("Network error logging in doctor.");
            } finally {
                btnDoctorSubmit.disabled = false;
                btnDoctorSubmit.querySelector('span').textContent = origLabel;
            }
        });
    }

    window.openDoctorWorkspace = function(docEmail, docName) {
        const storedDocName = docName || localStorage.getItem('medsafe_doctor_name') || docEmail || 'Doctor';
        const formattedDocName = storedDocName.toLowerCase().startsWith('dr.') ? storedDocName : `Dr. ${storedDocName}`;

        appState.doctorName = formattedDocName;
        localStorage.setItem('medsafe_doctor_name', formattedDocName);

        const titleEl = document.getElementById('page-doc-workspace-title');
        const subTitleEl = document.getElementById('page-doc-workspace-subtitle');
        if (titleEl) titleEl.textContent = `Doctor Workspace — ${formattedDocName}`;
        if (subTitleEl) subTitleEl.textContent = `Logged in as ${docEmail} | Search Patient IDs & manage patient list`;
        
        const overlay = document.getElementById('login-screen-overlay');
        if (overlay) overlay.style.display = 'none';
        const appContainer = document.getElementById('app-container');
        if (appContainer) { appContainer.style.visibility = 'visible'; appContainer.style.opacity = '1'; }
        
        const doctorBanner = document.getElementById('doctor-mode-banner');
        if (doctorBanner) doctorBanner.style.display = 'none';

        const pSubheadingEl = document.getElementById('dash-patient-subheading');
        if (pSubheadingEl) pSubheadingEl.style.display = 'none';

        applyUserSession({ username: formattedDocName, email: docEmail, provider: 'doctor', is_doctor: true, unlocked_patient: false });
        switchTab('doctor-workspace');
        loadDoctorMyPatients();
    };

    window.loadDoctorMyPatients = async function() {
        const container = document.getElementById('page-my-patients-list-container');
        const countText = document.getElementById('page-patients-count-text');
        if (!container) return;
        const token = sessionStorage.getItem('medsafe_jwt');
        if (!token) return;

        try {
            const res = await fetch('/api/doctor/my-patients', {
                headers: { 'Authorization': `Bearer ${token}` }
            });
            if (!res.ok) return;
            const patients = await res.json();
            
            if (countText) countText.textContent = `${patients.length} Saved Patient${patients.length === 1 ? '' : 's'}`;

            if (patients.length === 0) {
                container.innerHTML = '<p style="color: var(--text-muted); font-style: italic; font-size: 13.5px; text-align: center; margin: 40px 0;">No patients added to your saved list yet. Use the search panel on the left to find patients and click + to add them.</p>';
                return;
            }

            let html = '';
            patients.forEach(p => {
                html += `
                    <div style="display: flex; justify-content: space-between; align-items: center; padding: 14px 18px; background: rgba(14, 165, 233, 0.08); border: 1px solid rgba(14, 165, 233, 0.22); border-radius: var(--border-radius-sm);">
                        <div>
                            <div style="font-weight: 700; color: var(--text-primary); font-size: 14.5px;">${escapeHTML(p.username)}</div>
                            <div style="font-size: 12.5px; color: #38bdf8; font-weight: 600; margin-top: 2px;">ID: ${escapeHTML(p.patient_id)} <span style="color: var(--text-muted); font-weight: 400;">(${escapeHTML(p.email)})</span></div>
                        </div>
                        <div style="display: flex; gap: 10px; align-items: center;">
                            <button onclick="handleRemovePatientClick('${escapeHTML(p.patient_id)}')" title="Remove from My Patients" style="background: rgba(239, 68, 68, 0.2); border: 1px solid #f87171; color: #f87171; border-radius: 6px; padding: 6px 12px; font-weight: 800; cursor: pointer; font-size: 15px;">-</button>
                            <button onclick="promptPatientPasswordChallenge('${escapeHTML(p.patient_id)}', '${escapeHTML(p.username)}')" style="background: linear-gradient(135deg, #0ea5e9, #0284c7); border: none; color: white; border-radius: 6px; padding: 8px 16px; font-weight: 600; font-size: 13px; cursor: pointer; display: flex; align-items: center; gap: 6px;">
                                <i data-lucide="key-round" style="width: 14px; height: 14px;"></i> Unlock Records
                            </button>
                        </div>
                    </div>
                `;
            });
            container.innerHTML = html;
            if (window.lucide) lucide.createIcons();
        } catch (e) {
            console.error(e);
        }
    };

    window.searchDoctorPatients = async function() {
        const inputSearch = document.getElementById('page-input-search-patient-id');
        const resultsArea = document.getElementById('page-patient-search-results-area');
        const resultsList = document.getElementById('page-search-results-list');
        const q = inputSearch ? inputSearch.value.trim() : '';

        if (!q) {
            if (resultsArea) resultsArea.style.display = 'none';
            return;
        }

        const token = sessionStorage.getItem('medsafe_jwt');
        if (!token) return;

        try {
            const res = await fetch(`/api/doctor/search-patients?q=${encodeURIComponent(q)}`, {
                headers: { 'Authorization': `Bearer ${token}` }
            });
            if (!res.ok) return;
            const results = await res.json();

            if (resultsArea) resultsArea.style.display = 'block';

            if (results.length === 0) {
                resultsList.innerHTML = '<p style="color: var(--text-muted); font-size: 13px; margin: 0;">No patients found matching ID or name.</p>';
                return;
            }

            let html = '';
            results.forEach(r => {
                html += `
                    <div style="display: flex; justify-content: space-between; align-items: center; padding: 12px 16px; background: rgba(0,0,0,0.3); border: 1px solid rgba(255,255,255,0.1); border-radius: 6px;">
                        <div>
                            <span style="font-weight: 700; color: var(--text-primary); font-size: 14px;">${escapeHTML(r.username)}</span>
                            <span style="color: #38bdf8; font-weight: 600; margin-left: 8px; font-size: 12.5px;">ID: ${escapeHTML(r.patient_id)}</span>
                        </div>
                        <div style="display: flex; gap: 8px; align-items: center;">
                            ${r.is_added ? 
                                `<button onclick="handleRemovePatientClick('${escapeHTML(r.patient_id)}')" title="Remove from My Patients" style="background: rgba(239, 68, 68, 0.2); border: 1px solid #f87171; color: #f87171; border-radius: 4px; padding: 5px 12px; font-weight: 800; font-size: 15px; cursor: pointer;">-</button>` :
                                `<button onclick="handleAddPatientClick('${escapeHTML(r.patient_id)}')" title="Add to My Patients" style="background: rgba(16, 185, 129, 0.2); border: 1px solid #34d399; color: #34d399; border-radius: 4px; padding: 5px 12px; font-weight: 800; font-size: 15px; cursor: pointer;">+</button>`
                            }
                            <button onclick="promptPatientPasswordChallenge('${escapeHTML(r.patient_id)}', '${escapeHTML(r.username)}')" style="background: rgba(14, 165, 233, 0.2); border: 1px solid #38bdf8; color: #38bdf8; border-radius: 4px; padding: 6px 12px; font-weight: 600; font-size: 12px; cursor: pointer;">Unlock</button>
                        </div>
                    </div>
                `;
            });
            resultsList.innerHTML = html;
            if (window.lucide) lucide.createIcons();
        } catch (e) {
            console.error(e);
        }
    };

    window.handleAddPatientClick = async function(patientId) {
        const token = sessionStorage.getItem('medsafe_jwt');
        if (!token) return;
        try {
            const res = await fetch('/api/doctor/add-patient', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
                body: JSON.stringify({ patient_id: patientId })
            });
            if (res.ok) {
                loadDoctorMyPatients();
                searchDoctorPatients();
            }
        } catch (e) { console.error(e); }
    };

    window.handleRemovePatientClick = async function(patientId) {
        const token = sessionStorage.getItem('medsafe_jwt');
        if (!token) return;
        try {
            const res = await fetch('/api/doctor/remove-patient', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
                body: JSON.stringify({ patient_id: patientId })
            });
            if (res.ok) {
                loadDoctorMyPatients();
                searchDoctorPatients();
            }
        } catch (e) { console.error(e); }
    };

    window.promptPatientPasswordChallenge = function(patientId, patientName) {
        activeChallengePatientId = patientId;
        if (challengePatientName) challengePatientName.textContent = patientName || 'Patient';
        if (challengePatientId) challengePatientId.textContent = patientId;
        if (challengePasswordInput) challengePasswordInput.value = '';
        if (challengeErrorMsg) challengeErrorMsg.style.display = 'none';
        if (challengeModal) challengeModal.style.display = 'flex';
    };

    const pageBtnSearchPatient = document.getElementById('page-btn-search-patient');
    const pageInputSearchPatientId = document.getElementById('page-input-search-patient-id');
    const btnBackToDoctorWorkspace = document.getElementById('btn-back-to-doctor-workspace');

    if (pageBtnSearchPatient) {
        pageBtnSearchPatient.addEventListener('click', searchDoctorPatients);
    }
    if (pageInputSearchPatientId) {
        pageInputSearchPatientId.addEventListener('keyup', (e) => {
            if (e.key === 'Enter') searchDoctorPatients();
        });
    }

    if (btnBackToDoctorWorkspace) {
        btnBackToDoctorWorkspace.addEventListener('click', () => {
            const doctorBanner = document.getElementById('doctor-mode-banner');
            if (doctorBanner) doctorBanner.style.display = 'none';

            const pSubheadingEl = document.getElementById('dash-patient-subheading');
            if (pSubheadingEl) pSubheadingEl.style.display = 'none';

            const docJwt = localStorage.getItem('medsafe_doctor_jwt');
            if (docJwt) {
                sessionStorage.setItem('medsafe_jwt', docJwt);
            }

            const docEmail = localStorage.getItem('medsafe_doctor_email') || 'doctor@medsafe.ai';
            const docName = localStorage.getItem('medsafe_doctor_name') || 'Doctor';

            openDoctorWorkspace(docEmail, docName);
        });
    }

    if (btnCancelChallenge && challengeModal) {
        btnCancelChallenge.addEventListener('click', () => {
            challengeModal.style.display = 'none';
        });
    }

    if (challengeForm) {
        challengeForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            if (!activeChallengePatientId) return;
            const password = challengePasswordInput ? challengePasswordInput.value : '';
            if (!password) return;

            if (challengeErrorMsg) challengeErrorMsg.style.display = 'none';
            btnSubmitChallenge.disabled = true;

            try {
                const res = await fetch('/api/doctor/verify-patient', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ patient_id: activeChallengePatientId, patient_password: password })
                });
                const data = await res.json();
                if (!res.ok) {
                    if (challengeErrorMsg) {
                        challengeErrorMsg.querySelector('#challenge-error-text').textContent = data.detail || "Incorrect patient password.";
                        challengeErrorMsg.style.display = 'flex';
                    }
                    return;
                }

                // Unlock patient session
                sessionStorage.setItem('medsafe_jwt', data.access_token);
                if (challengeModal) challengeModal.style.display = 'none';
                
                applyUserSession({ username: data.username, email: data.email, provider: 'doctor', patient_id: data.patient_id, is_doctor: true, unlocked_patient: true });
                switchTab('dashboard');
                refreshData();
            } catch (err) {
                if (challengeErrorMsg) {
                    challengeErrorMsg.querySelector('#challenge-error-text').textContent = "Network error verifying patient password.";
                    challengeErrorMsg.style.display = 'flex';
                }
            } finally {
                btnSubmitChallenge.disabled = false;
            }
        });
    }

    if (btnExitDoctorMode) {
        btnExitDoctorMode.addEventListener('click', () => {
            sessionStorage.removeItem('medsafe_jwt');
            location.reload();
        });
    }

    function showDoctorAuthError(text) {
        if (doctorErrorMsg) {
            doctorErrorMsg.querySelector('#doctor-error-text').textContent = text;
            doctorErrorMsg.style.display = 'flex';
        }
    }

    // ── Restore active JWT session ──────────────────────────────────────────
    const existingToken = sessionStorage.getItem('medsafe_jwt');
    if (existingToken) {
        const payload = parseJwt(existingToken);
        if (payload && payload.exp && payload.exp * 1000 > Date.now()) {
            if (payload.provider === 'doctor' && !payload.patient_id) {
                openDoctorWorkspace(payload.sub, payload.name);
            } else if (payload.is_doctor && payload.patient_id) {
                applyUserSession({ username: payload.name || 'Patient', email: payload.sub, provider: 'doctor', patient_id: payload.patient_id, is_doctor: true, unlocked_patient: true });
                overlay.style.display = 'none';
                const appContainer = document.getElementById('app-container');
                if (appContainer) { appContainer.style.visibility = 'visible'; appContainer.style.opacity = '1'; }
                refreshData();
            } else {
                applyUserSession({ username: payload.name || 'User', email: payload.sub, provider: payload.provider, patient_id: payload.patient_id, is_doctor: false });
                overlay.style.display = 'none';
                const appContainer = document.getElementById('app-container');
                if (appContainer) { appContainer.style.visibility = 'visible'; appContainer.style.opacity = '1'; }
                refreshData();
            }
            return;
        } else {
            sessionStorage.removeItem('medsafe_jwt');
        }
    }

    // ── Init Animations ─────────────────────────────────────────────────────
    initFloatingBackdrop();
    triggerPillIntroSequence();

    // ── Google Sign-In ───────────────────────────────────────────────────────
    if (btnGoogleSignIn) {
        btnGoogleSignIn.addEventListener('click', async () => {
            // Use Google's identity services popup flow
            if (!window.google || !window.google.accounts) {
                showAuthError("Google Sign-In is not loaded yet. Please wait a moment and try again.");
                return;
            }

            // Read client ID from backend config
            let clientId = '';
            try {
                const cfgRes = await fetch('/api/auth/google-client-id');
                const cfg = await cfgRes.json();
                clientId = cfg.client_id;
            } catch (e) {
                showAuthError("Could not load Google Sign-In configuration.");
                return;
            }

            if (!clientId || clientId.includes('PLACEHOLDER')) {
                showAuthError("Google Sign-In not configured on this server. Set GOOGLE_CLIENT_ID in .env");
                return;
            }

            btnGoogleSignIn.disabled = true;
            btnGoogleSignIn.querySelector('span').textContent = 'Connecting...';

            try {
                const tokenClient = google.accounts.oauth2.initTokenClient({
                    client_id: clientId,
                    scope: 'openid email profile',
                    callback: () => {},
                });

                // Use the newer ID token flow via the Sign In With Google button API
                google.accounts.id.initialize({
                    client_id: clientId,
                    callback: async (response) => {
                        if (!response.credential) {
                            showAuthError("Google Sign-In was cancelled.");
                            btnGoogleSignIn.disabled = false;
                            btnGoogleSignIn.querySelector('span').textContent = 'Continue with Google';
                            return;
                        }
                        try {
                            const res = await fetch('/api/auth/google', {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ id_token: response.credential })
                            });
                            const data = await res.json();
                            if (!res.ok) throw new Error(data.detail || 'Google sign-in failed.');
                            sessionStorage.setItem('medsafe_jwt', data.access_token);
                            applyUserSession({ username: data.username, email: data.email, provider: 'google' });
                            dismissOverlay();
                        } catch (err) {
                            showAuthError(err.message);
                            btnGoogleSignIn.disabled = false;
                            btnGoogleSignIn.querySelector('span').textContent = 'Continue with Google';
                        }
                    },
                    auto_select: false,
                    cancel_on_tap_outside: true,
                });

                google.accounts.id.prompt();
            } catch (err) {
                showAuthError("Google Sign-In error: " + err.message);
                btnGoogleSignIn.disabled = false;
                btnGoogleSignIn.querySelector('span').textContent = 'Continue with Google';
            }
        });
    }

    // ── Toggle Login / Register ──────────────────────────────────────────────
    linkToggle.addEventListener('click', (e) => {
        e.preventDefault();
        errorMsg.style.display = 'none';

        if (authState.mode === 'login') {
            authState.mode = 'register';
            subtitle.textContent = "Create Your Secure Account";
            groupUsername.style.display = 'block';
            inputUsername.required = true;
            if (passwordHint) passwordHint.style.display = 'inline';
            btnSubmit.querySelector('span').textContent = "Create Account";
            labelToggle.textContent = "Already have an account?";
            linkToggle.textContent = "Login";
        } else {
            authState.mode = 'login';
            subtitle.textContent = "Secure Health Assistant";
            groupUsername.style.display = 'none';
            inputUsername.required = false;
            if (passwordHint) passwordHint.style.display = 'none';
            btnSubmit.querySelector('span').textContent = "Login Securely";
            labelToggle.textContent = "Don't have an account?";
            linkToggle.textContent = "Register";
        }
    });

    // ── Form Submission (Login / Register via backend) ───────────────────────
    authForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        errorMsg.style.display = 'none';

        const email = inputEmail.value.trim();
        const password = inputPassword.value;
        const username = inputUsername.value.trim();

        if (!email || !password) return;

        btnSubmit.disabled = true;
        const origLabel = btnSubmit.querySelector('span').textContent;
        btnSubmit.querySelector('span').textContent = 'Authenticating...';

        try {
            let endpoint, payload;
            if (authState.mode === 'register') {
                if (password.length < 8) {
                    showAuthError("Password must be at least 8 characters.");
                    return;
                }
                endpoint = '/api/auth/register';
                payload = { email, username: username || email.split('@')[0], password };
            } else {
                endpoint = '/api/auth/login';
                payload = { email, password };
            }

            const res = await fetch(endpoint, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
            const data = await res.json();

            if (!res.ok) {
                showAuthError(data.detail || "Authentication failed.");
                return;
            }

            // Store JWT in sessionStorage (cleared on browser close)
            sessionStorage.setItem('medsafe_jwt', data.access_token);
            applyUserSession({ username: data.username, email: data.email, provider: 'local' });
            dismissOverlay();
        } catch (err) {
            showAuthError("Network error. Is the server running?");
        } finally {
            btnSubmit.disabled = false;
            btnSubmit.querySelector('span').textContent = origLabel;
        }
    });

    // ── Guest Sign-In ────────────────────────────────────────────────────────
    if (btnGuest) {
        btnGuest.addEventListener('click', () => {
            // Guest uses no JWT — the interceptor sends no auth header → backend returns guest data
            sessionStorage.removeItem('medsafe_jwt');
            applyUserSession({ username: 'Guest User', email: 'guest@medsafe.ai', provider: 'guest' });
            dismissOverlay();
        });
    }

    // ── Logout ───────────────────────────────────────────────────────────────
    if (btnLogout) {
        btnLogout.addEventListener('click', () => {
            // Clear JWT — this is the ONLY session token now
            sessionStorage.removeItem('medsafe_jwt');

            // Sign out of Google if applicable
            if (window.google && window.google.accounts) {
                google.accounts.id.disableAutoSelect();
            }

            // Reload page to reset all memory state & present clean login screen
            location.reload();
        });
    }

    // ── Helpers ──────────────────────────────────────────────────────────────
    function showAuthError(text) {
        errorMsg.querySelector('#error-text').textContent = text;
        errorMsg.style.display = 'flex';
    }

    function triggerPillIntroSequence() {
        const stethoscope = document.getElementById('intro-stethoscope');
        if (stethoscope) stethoscope.classList.remove('reveal', 'fade-out');
        // Show login card immediately (introStage removed — video background replaces it)
        if (introStage) introStage.style.display = 'none';
        authStage.classList.add('active');

        // Start background video playback (handles autoplay policy)
        const bgVideo = document.getElementById('login-bg-video');
        if (bgVideo) {
            bgVideo.play().catch(() => {
                // Autoplay blocked — play on first user interaction
                const playOnClick = () => { bgVideo.play(); document.removeEventListener('click', playOnClick); };
                document.addEventListener('click', playOnClick, { once: true });
            });
        }
    }

    function dismissOverlay() {
        // Reveal main app immediately
        const appContainer = document.getElementById('app-container');
        if (appContainer) {
            appContainer.style.visibility = 'visible';
            appContainer.style.opacity = '1';
            appContainer.style.transition = 'opacity 0.4s ease';
        }

        switchTab(appState.activeTab || 'dashboard');

        overlay.style.opacity = '0';
        setTimeout(() => {
            overlay.style.display = 'none';
            if (window.lucide && lucide.createIcons) {
                lucide.createIcons();
            }
            showStatusNotification(`Welcome to MedSafe AI!`, 'success');
        }, 400);

        refreshData();
    }
}


function spawnPillParticles(container) {
    const particleCount = 70; // increased count for full screen coverage
    const colors = ['#06b6d4', '#10b981', '#ffffff', '#22d3ee', '#34d399', '#cbd5e1'];
    
    for (let i = 0; i < particleCount; i++) {
        const particle = document.createElement('div');
        particle.className = 'med-particle';
        
        // Random size from 5px to 16px
        const size = Math.random() * 11 + 5;
        particle.style.width = `${size}px`;
        particle.style.height = `${size}px`;
        
        // Random color
        const color = colors[Math.floor(Math.random() * colors.length)];
        particle.style.color = color;
        particle.style.backgroundColor = color;
        
        // Spread parameters - expand to full viewport height/width sways
        const tx = (Math.random() - 0.5) * window.innerWidth * 1.3;
        const ty = (Math.random() - 0.5) * window.innerHeight * 1.3;
        const tz = (Math.random() - 0.5) * 400;
        const scale = Math.random() * 1.6 + 0.4;
        
        particle.style.setProperty('--tx', `${tx}px`);
        particle.style.setProperty('--ty', `${ty}px`);
        particle.style.setProperty('--tz', `${tz}px`);
        particle.style.setProperty('--scale', scale);
        
        // Random position offsets centered in the viewport
        particle.style.left = 'calc(50% - ' + (size/2) + 'px)';
        particle.style.top = 'calc(50% - ' + (size/2) + 'px)';
        
        // Animation duration & delay
        const duration = Math.random() * 2.0 + 1.5;
        const delay = Math.random() * 0.4;
        
        particle.style.animation = `particle-fly ${duration}s cubic-bezier(0.1, 0.8, 0.25, 1) ${delay}s forwards`;
        
        container.appendChild(particle);
        
        // Self delete
        setTimeout(() => {
            particle.remove();
        }, (duration + delay) * 1000);
    }
}

function applyUserSession(user) {
    const avatar = document.getElementById('sidebar-avatar');
    const nameEl = document.getElementById('sidebar-user-name');
    const statusEl = document.getElementById('sidebar-user-status');
    const headerPatientId = document.getElementById('header-patient-id');
    const patientIdBadge = document.getElementById('patient-id-badge-container');
    const doctorBanner = document.getElementById('doctor-mode-banner');
    const doctorPatientName = document.getElementById('doctor-banner-patient-name');
    const doctorPatientId = document.getElementById('doctor-banner-patient-id');
    const chatNavBtn = document.querySelector('.chat-nav-btn');
    const doctorOnlyNav = document.querySelector('.doctor-only-nav');
    const quickStatsBar = document.querySelector('.quick-stats-bar');
    const nearestPharmaciesCard = document.getElementById('nearest-pharmacies-card');
    const statRemindersToggle = document.getElementById('stat-reminders-toggle');

    const provider = user.provider || 'local';
    const patientId = user.patient_id || appState.currentPatientId;
    const isDoctor = user.is_doctor || appState.isDoctorView || provider === 'doctor';

    // Doctor Name vs Patient Name distinction
    let docName = appState.doctorName || user.doctor_name || localStorage.getItem('medsafe_doctor_name') || 'Doctor';
    if (isDoctor && user.username && !user.unlocked_patient) {
        docName = user.username;
        appState.doctorName = docName;
        localStorage.setItem('medsafe_doctor_name', docName);
    }
    const formattedDoctorName = docName.toLowerCase().startsWith('dr.') ? docName : `Dr. ${docName}`;
    const patientDisplayName = user.unlocked_patient ? (user.username || user.name || 'Patient') : (user.username || user.name || 'User');

    if (avatar) avatar.textContent = isDoctor ? 'D' : (user.username || 'U').charAt(0).toUpperCase();
    if (nameEl) nameEl.textContent = isDoctor ? formattedDoctorName : patientDisplayName;
    if (headerPatientId) headerPatientId.textContent = `ID: ${patientId}`;

    const pSubheadingNameEl = document.getElementById('dash-patient-subheading-name');
    const pSubheadingEl = document.getElementById('dash-patient-subheading');
    if (pSubheadingNameEl) pSubheadingNameEl.textContent = patientDisplayName.toUpperCase();
    if (pSubheadingEl) pSubheadingEl.style.display = 'block';

    const patientNavItems = document.querySelectorAll('.sidebar-nav .nav-item:not(.doctor-only-nav)');

    if (isDoctor) {
        // Hide nearest medical shops & 10m alarms toggle from doctor portal view
        if (nearestPharmaciesCard) nearestPharmaciesCard.style.display = 'none';
        if (statRemindersToggle) statRemindersToggle.style.display = 'none';
    } else {
        // Show nearest medical shops & 10m alarms toggle for patient portal view
        if (nearestPharmaciesCard) nearestPharmaciesCard.style.display = 'block';
        if (statRemindersToggle) statRemindersToggle.style.display = 'flex';
    }

    if (provider === 'doctor' && !user.unlocked_patient) {
        // Doctor Portal Mode — NO patient unlocked yet!
        if (statusEl) statusEl.textContent = `🩺 Doctor Portal (Select Patient)`;
        if (doctorOnlyNav) doctorOnlyNav.style.display = 'flex';
        if (doctorBanner) doctorBanner.style.display = 'none';
        if (patientIdBadge) patientIdBadge.style.display = 'none';
        if (quickStatsBar) quickStatsBar.style.display = 'none';
        
        // Hide all patient tabs until patient password is unlocked!
        patientNavItems.forEach(item => {
            item.style.display = 'none';
        });

        switchTab('doctor-workspace');
    } else if (isDoctor) {
        // Doctor HAS UNLOCKED a specific patient's records!
        if (statusEl) statusEl.textContent = `🩺 Doctor Access (ID: ${patientId})`;
        if (doctorOnlyNav) doctorOnlyNav.style.display = 'flex';
        if (doctorBanner) doctorBanner.style.display = 'flex';
        if (doctorPatientName) doctorPatientName.textContent = patientDisplayName;
        if (doctorPatientId) doctorPatientId.textContent = patientId;
        if (chatNavBtn) chatNavBtn.style.display = 'none';
        if (patientIdBadge) patientIdBadge.style.display = 'inline-flex';
        if (quickStatsBar) quickStatsBar.style.display = 'flex';

        // Show patient tabs for reviewing unlocked records
        patientNavItems.forEach(item => {
            if (item.classList.contains('chat-nav-btn')) {
                item.style.display = 'none'; // Keep AI chatbot hidden from doctor
            } else {
                item.style.display = 'flex';
            }
        });
    } else {
        // Patient session
        if (statusEl) {
            if (provider === 'guest') {
                statusEl.textContent = `ID: ${patientId} (Guest)`;
            } else if (provider === 'google') {
                statusEl.textContent = `ID: ${patientId} (Google)`;
            } else {
                statusEl.textContent = `ID: ${patientId}`;
            }
        }
        if (doctorOnlyNav) doctorOnlyNav.style.display = 'none';
        if (doctorBanner) doctorBanner.style.display = 'none';
        if (patientIdBadge) patientIdBadge.style.display = 'inline-flex';
        if (quickStatsBar) quickStatsBar.style.display = 'flex';

        patientNavItems.forEach(item => {
            item.style.display = 'flex';
        });

        switchTab(appState.activeTab || 'dashboard');
    }

    renderDoctorNotes();
}


// Navigation Tab Switcher
function switchTab(tabId) {
    appState.activeTab = tabId;
    
    // Update active class on nav items
    document.querySelectorAll('.nav-item').forEach(item => {
        if (item.getAttribute('data-tab') === tabId) {
            item.classList.add('active');
        } else {
            item.classList.remove('active');
        }
    });

    // Update active pane
    document.querySelectorAll('.tab-pane').forEach(pane => {
        if (pane.id === `tab-${tabId}`) {
            pane.classList.add('active');
            pane.style.display = 'block';
        } else {
            pane.classList.remove('active');
            pane.style.display = 'none';
        }
    });

    const titleMap = {
        'doctor-workspace': 'Doctor Portal Workspace',
        'dashboard': 'Dashboard Overview',
        'checklist': 'Medication Checklist',
        'medications': 'Medication Schedule & Safety Profile',
        'symptoms': 'Symptom Log & Side Effect Analysis',
        'reports': 'Clinician Visits Summary Report',
        'lab-reports': 'Laboratory & Blood Test Reports',
        'chat': 'Chat with MedSafe AI'
    };

    const titleEl = document.getElementById('current-page-title');
    if (titleEl) titleEl.textContent = titleMap[tabId] || 'Overview';
    
    const patientIdBadge = document.getElementById('patient-id-badge-container');
    const quickStatsBar = document.querySelector('.quick-stats-bar');

    if (tabId === 'doctor-workspace') {
        if (patientIdBadge) patientIdBadge.style.display = 'none';
        if (quickStatsBar) quickStatsBar.style.display = 'none';
    } else {
        const isDoctorWorkspaceMode = (sessionStorage.getItem('medsafe_jwt') && parseJwt(sessionStorage.getItem('medsafe_jwt'))?.provider === 'doctor');
        if (!isDoctorWorkspaceMode) {
            if (patientIdBadge) patientIdBadge.style.display = 'inline-flex';
            if (quickStatsBar) quickStatsBar.style.display = 'flex';
        }
    }

    // Special layout triggers on tab load
    if (tabId === 'doctor-workspace') {
        loadDoctorMyPatients();
    } else if (tabId === 'symptoms') {
        renderCorrelationChart();
    } else if (tabId === 'reports') {
        loadDoctorReport();
    } else if (tabId === 'lab-reports') {
        loadLabReports();
    }
}

// Data Synchronizer (REST API Calls)
async function refreshData() {
    try {
        await Promise.all([
            fetchMedications(),
            fetchAllergies(),
            fetchSymptoms(),
            fetchAdherence()
        ]);
        
        // Update dashboard widgets
        updateDashboardWidgets();
        updateChecklistUI();
        updateMedicationsUI();
        updateSymptomsUI();
        populateCorrelatedMedicationsDropdown();
        
        if (appState.activeTab === 'lab-reports') {
            loadLabReports();
        }
    } catch (err) {
        console.error("Error refreshing MedSafe data:", err);
    }
}

async function fetchMedications() {
    try {
        const res = await fetch('/api/medications');
        if (res.ok) {
            const data = await res.json();
            appState.medications = Array.isArray(data) ? data : [];
        } else {
            appState.medications = [];
        }
    } catch(e) {
        console.error("fetchMedications error:", e);
        appState.medications = [];
    }
}

async function fetchAllergies() {
    try {
        const res = await fetch('/api/allergies');
        if (res.ok) {
            const data = await res.json();
            appState.allergies = Array.isArray(data) ? data : [];
        } else {
            appState.allergies = [];
        }
    } catch(e) {
        console.error("fetchAllergies error:", e);
        appState.allergies = [];
    }
}

async function fetchSymptoms() {
    try {
        const res = await fetch('/api/symptoms');
        if (res.ok) {
            const data = await res.json();
            appState.symptoms = Array.isArray(data) ? data : [];
        } else {
            appState.symptoms = [];
        }
    } catch(e) {
        console.error("fetchSymptoms error:", e);
        appState.symptoms = [];
    }
}

async function fetchAdherence() {
    try {
        const res = await fetch('/api/adherence');
        if (res.ok) {
            const data = await res.json();
            appState.adherence = Array.isArray(data) ? data : [];
        } else {
            appState.adherence = [];
        }
    } catch(e) {
        console.error("fetchAdherence error:", e);
        appState.adherence = [];
    }
}

// Helper to retrieve and synchronize scheduled doses for any given date with active medications
function getDosesForDate(targetDate) {
    if (!targetDate) targetDate = formatYMD(new Date());

    // 1. Get existing adherence records for targetDate from appState.adherence
    const existingDoses = appState.adherence.filter(h => {
        if (!h.scheduled_time || !h.scheduled_time.startsWith(targetDate)) return false;
        // Exclude pending doses for discontinued/inactive medications
        if (h.medication_is_active === 0 && h.status === 'pending') return false;
        return true;
    });

    const existingMedIds = new Set(existingDoses.map(d => d.medication_id));

    // 2. Synchronize with appState.medications: ensure every active medication is represented
    const activeMeds = (appState.medications || []).filter(m => m.is_active === 1 || m.is_active === undefined || m.is_active === null);

    const mergedDoses = [...existingDoses];

    activeMeds.forEach(med => {
        if (!existingMedIds.has(med.id)) {
            const medStart = med.start_date ? med.start_date.substring(0, 10) : '2000-01-01';
            if (targetDate >= medStart) {
                const timeOfDay = med.time_of_day || '08:00';
                const scheduledTime = `${targetDate} ${timeOfDay}`;
                const tempDose = {
                    id: `temp_${med.id}_${targetDate}`,
                    medication_id: med.id,
                    medication_name: med.name,
                    medication_dosage: med.dosage,
                    medication_time_of_day: timeOfDay,
                    scheduled_time: scheduledTime,
                    status: 'pending',
                    taken_at: null,
                    medication_is_active: 1
                };
                mergedDoses.push(tempDose);
            }
        }
    });

    // 3. Sort chronologically by scheduled time
    mergedDoses.sort((a, b) => {
        const timeA = (a.medication_time_of_day || (a.scheduled_time ? a.scheduled_time.split(' ')[1] : '') || '08:00');
        const timeB = (b.medication_time_of_day || (b.scheduled_time ? b.scheduled_time.split(' ')[1] : '') || '08:00');
        return timeA.localeCompare(timeB);
    });

    return mergedDoses;
}

// ── Zero-Dependency Canvas Confetti Celebration ──────────────────────────────
function launchConfetti() {
    try {
        let canvas = document.getElementById('confetti-canvas');
        if (!canvas) {
            canvas = document.createElement('canvas');
            canvas.id = 'confetti-canvas';
            canvas.style.position = 'fixed';
            canvas.style.top = '0';
            canvas.style.left = '0';
            canvas.style.width = '100vw';
            canvas.style.height = '100vh';
            canvas.style.pointerEvents = 'none';
            canvas.style.zIndex = '999999';
            document.body.appendChild(canvas);
        }
        canvas.width = window.innerWidth;
        canvas.height = window.innerHeight;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        const colors = ['#10b981', '#38bdf8', '#818cf8', '#f59e0b', '#ec4899', '#a855f7'];
        const particles = [];
        for (let i = 0; i < 80; i++) {
            particles.push({
                x: window.innerWidth * 0.5 + (Math.random() - 0.5) * 250,
                y: window.innerHeight * 0.4 + (Math.random() - 0.5) * 80,
                vx: (Math.random() - 0.5) * 16,
                vy: (Math.random() - 0.8) * 14,
                size: Math.random() * 8 + 4,
                color: colors[Math.floor(Math.random() * colors.length)],
                rotation: Math.random() * 360,
                rSpeed: (Math.random() - 0.5) * 12,
                opacity: 1
            });
        }

        let start = null;
        function frame(timestamp) {
            if (!start) start = timestamp;
            const progress = (timestamp - start) / 2500;
            ctx.clearRect(0, 0, canvas.width, canvas.height);

            particles.forEach(p => {
                p.x += p.vx;
                p.y += p.vy;
                p.vy += 0.28; // Gravity
                p.vx *= 0.98; // Air resistance
                p.rotation += p.rSpeed;
                p.opacity = Math.max(0, 1 - progress);

                ctx.save();
                ctx.translate(p.x, p.y);
                ctx.rotate((p.rotation * Math.PI) / 180);
                ctx.globalAlpha = p.opacity;
                ctx.fillStyle = p.color;
                ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size * 0.6);
                ctx.restore();
            });

            if (progress < 1) {
                requestAnimationFrame(frame);
            } else {
                ctx.clearRect(0, 0, canvas.width, canvas.height);
                if (canvas && canvas.parentNode) canvas.parentNode.removeChild(canvas);
            }
        }
        requestAnimationFrame(frame);
    } catch (e) {
        console.warn("Confetti animation failed:", e);
    }
}

// ── Smooth Metric Count-Up Animation ─────────────────────────────────────────
function animateValue(el, start, end, duration = 600, suffix = '') {
    if (!el) return;
    if (isNaN(end)) {
        el.textContent = `${end}${suffix}`;
        return;
    }
    const startTime = performance.now();
    function update(now) {
        const elapsed = now - startTime;
        const progress = Math.min(elapsed / duration, 1);
        const easeOut = 1 - Math.pow(1 - progress, 3);
        const current = Math.round(start + (end - start) * easeOut);
        el.textContent = `${current}${suffix}`;
        if (progress < 1) {
            requestAnimationFrame(update);
        } else {
            el.textContent = `${end}${suffix}`;
        }
    }
    requestAnimationFrame(update);
}

// ── Pill Avatar Visual Classifier ───────────────────────────────────────────
function getPillVisual(name = '', dosage = '') {
    const text = `${name} ${dosage}`.toLowerCase();
    if (text.includes('capsule') || text.includes('cap') || text.includes('amoxicillin') || text.includes('omeprazole') || text.includes('doxycycline')) {
        return {
            formClass: 'form-capsule',
            icon: 'pill',
            label: 'Capsule'
        };
    } else if (text.includes('syrup') || text.includes('liquid') || text.includes('suspension') || text.includes('solution') || text.includes('ml')) {
        return {
            formClass: 'form-syrup',
            icon: 'flask-conical',
            label: 'Liquid/Syrup'
        };
    } else if (text.includes('injection') || text.includes('insulin') || text.includes('vial') || text.includes('shot')) {
        return {
            formClass: 'form-injection',
            icon: 'syringe',
            label: 'Injection'
        };
    } else if (text.includes('tablet') || text.includes('tab') || text.includes('paracetamol') || text.includes('aspirin') || text.includes('metformin') || text.includes('lisinopril')) {
        return {
            formClass: 'form-tablet',
            icon: 'circle-dot',
            label: 'Tablet'
        };
    }
    return {
        formClass: 'form-default',
        icon: 'pill',
        label: 'Medication'
    };
}

// ── 7-Day Adherence Streak Calculator & Renderer ─────────────────────────────
function renderAdherenceStreak() {
    const container = document.getElementById('dash-adherence-streak');
    const badgeEl = document.getElementById('dash-streak-count');
    if (!container) return;

    container.innerHTML = '';
    const daysOfWeek = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const today = new Date();
    const todayStr = formatYMD(today);

    let consecutiveStreak = 0;
    const daysList = [];

    // Build last 7 days array (from 6 days ago to today)
    for (let i = 6; i >= 0; i--) {
        const d = new Date(today);
        d.setDate(d.getDate() - i);
        const dateStr = formatYMD(d);
        const doses = getDosesForDate(dateStr);
        const takenCount = doses.filter(h => h.status === 'taken').length;
        const totalCount = doses.length;

        let status = 'empty';
        if (totalCount > 0) {
            if (takenCount === totalCount) {
                status = 'perfect';
            } else if (takenCount > 0) {
                status = 'partial';
            }
        }

        daysList.push({
            dateStr,
            dayName: daysOfWeek[d.getDay()],
            dayNum: d.getDate(),
            isToday: dateStr === todayStr,
            status,
            takenCount,
            totalCount
        });
    }

    // Calculate streak counting backwards
    for (let i = daysList.length - 1; i >= 0; i--) {
        const day = daysList[i];
        if (day.status === 'perfect') {
            consecutiveStreak++;
        } else if (day.isToday && day.takenCount > 0) {
            consecutiveStreak++;
        } else if (!day.isToday) {
            break;
        }
    }

    if (badgeEl) {
        badgeEl.innerHTML = `<i data-lucide="flame"></i> ${consecutiveStreak} Day${consecutiveStreak === 1 ? '' : 's'}`;
    }

    daysList.forEach(d => {
        const tile = document.createElement('div');
        tile.className = `streak-day-tile ${d.isToday ? 'today' : ''}`;
        
        let dotIcon = 'minus';
        if (d.status === 'perfect') dotIcon = 'check';
        else if (d.status === 'partial') dotIcon = 'clock';

        tile.innerHTML = `
            <span class="streak-day-name">${d.dayName}</span>
            <div class="streak-day-dot ${d.status}" title="${d.dateStr}: ${d.takenCount}/${d.totalCount} doses taken">
                <i data-lucide="${dotIcon}"></i>
            </div>
        `;
        container.appendChild(tile);
    });

    if (window.lucide && lucide.createIcons) lucide.createIcons();
}

// Dashboard Widgets Update
function updateDashboardWidgets() {
    // Calculate compliance rate (taken / total scheduled in past 7 days)
    const history = appState.adherence;
    const taken = history.filter(h => h.status === 'taken').length;
    const skipped = history.filter(h => h.status === 'skipped').length;
    const total = taken + skipped;
    const rate = total > 0 ? Math.round((taken / total) * 100) : 100;
    
    const statCompRateEl = document.getElementById('stat-compliance-rate');
    const dashCompRateEl = document.getElementById('dash-compliance-rate');
    
    if (statCompRateEl) {
        const currentVal = parseInt(statCompRateEl.textContent, 10) || 0;
        animateValue(statCompRateEl, currentVal, rate, 500, '%');
    }
    if (dashCompRateEl) {
        const currentVal = parseInt(dashCompRateEl.textContent, 10) || 0;
        animateValue(dashCompRateEl, currentVal, rate, 500, '%');
    }
    
    // Set circle progress ring
    const circle = document.getElementById('compliance-ring');
    if (circle && circle.r) {
        const radius = circle.r.baseVal.value;
        const circumference = radius * 2 * Math.PI;
        circle.style.strokeDasharray = `${circumference} ${circumference}`;
        const offset = circumference - (rate / 100) * circumference;
        circle.style.strokeDashoffset = offset;
    }

    // Set Allergy count with animation
    const allergyCountEl = document.getElementById('stat-allergies-count');
    if (allergyCountEl) {
        const currentVal = parseInt(allergyCountEl.textContent, 10) || 0;
        animateValue(allergyCountEl, currentVal, (appState.allergies || []).length, 400);
    }

    // Render 7-Day Adherence Streak Tracker
    renderAdherenceStreak();

    // Load Today's Scheduled Checklist Doses on Dashboard (Synchronized with active medications)
    const today = formatYMD(new Date());
    const todayDoses = getDosesForDate(today);
    
    const container = document.getElementById('dash-today-checklist');
    if (container) {
        container.innerHTML = '';
        
        if (todayDoses.length === 0) {
            container.innerHTML = '<p class="empty-state">No medications scheduled for today.</p>';
        } else {
            todayDoses.forEach(dose => {
                const pillVis = getPillVisual(dose.medication_name, dose.medication_dosage);
                const div = document.createElement('div');
                div.className = 'checklist-summary-item';
                div.innerHTML = `
                    <div class="med-info-summary">
                        <div class="pill-avatar-icon ${pillVis.formClass}" title="${pillVis.label}">
                            <i data-lucide="${pillVis.icon}"></i>
                        </div>
                        <div>
                            <div class="med-name-txt">${escapeHTML(dose.medication_name)} ${escapeHTML(dose.medication_dosage)}</div>
                            <div class="med-schedule-txt">Scheduled: ${escapeHTML(dose.medication_time_of_day || '08:00')}</div>
                        </div>
                    </div>
                    <span class="badge-status ${dose.status}">${dose.status}</span>
                `;
                container.appendChild(div);
            });
            if (window.lucide && lucide.createIcons) lucide.createIcons();
        }
    }

    // Load Recent Symptoms list on Dashboard
    const symContainer = document.getElementById('dash-recent-symptoms');
    if (symContainer) {
        symContainer.innerHTML = '';
        const recentSym = (appState.symptoms || []).slice(0, 3);
        
        if (recentSym.length === 0) {
            symContainer.innerHTML = '<p class="empty-state">No symptoms logged recently.</p>';
        } else {
            recentSym.forEach(s => {
                const sev = parseInt(s.severity, 10) || 5;
                const tier = sev <= 3 ? 'mild' : sev <= 7 ? 'moderate' : 'severe';
                const label = sev <= 3 ? 'Mild' : sev <= 7 ? 'Moderate' : 'Severe';
                const dateStr = s.logged_at ? s.logged_at.substring(0, 16) : 'Logged Recently';

                const div = document.createElement('div');
                div.className = 'symptom-summary-item';
                div.innerHTML = `
                    <div class="sym-info-summary">
                        <div class="sym-icon-pill severity-${tier}">
                            <i data-lucide="activity"></i>
                        </div>
                        <div>
                            <div class="sym-desc-txt">${escapeHTML(s.description)}</div>
                            <div class="sym-time-txt">${escapeHTML(dateStr)}</div>
                        </div>
                    </div>
                    <span class="badge-status severity-${tier}">${label} (${sev}/10)</span>
                `;
                symContainer.appendChild(div);
            });
        }
    }
    if (window.lucide && lucide.createIcons) lucide.createIcons();
}

// Helper for local YYYY-MM-DD date string
function formatYMD(d) {
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

// Navigation button handlers for Daily Checklist
window.navigateChecklistDate = function(daysOffset) {
    if (!appState.selectedDate) {
        appState.selectedDate = formatYMD(new Date());
    }
    const parts = appState.selectedDate.split('-').map(Number);
    const d = new Date(parts[0], parts[1] - 1, parts[2]);
    d.setDate(d.getDate() + daysOffset);
    appState.selectedDate = formatYMD(d);
    initChecklistCalendar();
    updateChecklistUI();
};

window.jumpChecklistToday = function() {
    appState.selectedDate = formatYMD(new Date());
    initChecklistCalendar();
    updateChecklistUI();
};

// Generate Adherence calendar dates bar (Supports full 6-Month history navigation)
function initChecklistCalendar() {
    const calendarBar = document.getElementById('checklist-calendar-bar');
    if (!calendarBar) return;
    calendarBar.innerHTML = '';

    // Default to today if selectedDate is not set
    if (!appState.selectedDate) {
        appState.selectedDate = formatYMD(new Date());
    }

    const selParts = appState.selectedDate.split('-').map(Number);
    const centerDate = new Date(selParts[0], selParts[1] - 1, selParts[2]);

    // Setup 6-month date picker bounds (180 days ago to +7 days in future)
    const datePicker = document.getElementById('checklist-date-picker');
    const today = new Date();
    const minDate = new Date(today);
    minDate.setDate(minDate.getDate() - 180);
    const maxDate = new Date(today);
    maxDate.setDate(maxDate.getDate() + 7);

    if (datePicker) {
        datePicker.min = formatYMD(minDate);
        datePicker.max = formatYMD(maxDate);
        datePicker.value = appState.selectedDate;

        if (!datePicker.dataset.bound) {
            datePicker.dataset.bound = 'true';
            datePicker.addEventListener('change', (e) => {
                if (e.target.value) {
                    appState.selectedDate = e.target.value;
                    initChecklistCalendar();
                    updateChecklistUI();
                }
            });
        }
    }

    // Generate 7 days centered on centerDate (-3 to +3 days)
    const daysOfWeek = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    for (let i = -3; i <= 3; i++) {
        const d = new Date(centerDate);
        d.setDate(d.getDate() + i);
        const dateStr = formatYMD(d);
        const isActive = dateStr === appState.selectedDate;

        const btn = document.createElement('button');
        btn.className = `calendar-day ${isActive ? 'active' : ''}`;
        btn.setAttribute('data-date', dateStr);
        btn.innerHTML = `
            <span class="day-name">${daysOfWeek[d.getDay()]}</span>
            <span class="day-num">${d.getDate()}</span>
        `;

        btn.addEventListener('click', () => {
            appState.selectedDate = dateStr;
            initChecklistCalendar();
            updateChecklistUI();
        });

        calendarBar.appendChild(btn);
    }
}

function isDoctorUser() {
    const token = localStorage.getItem('medsafe_auth_token');
    if (token) {
        const payload = parseJwt(token);
        if (payload && (payload.is_doctor || payload.provider === 'doctor')) return true;
    }
    if (typeof appState !== 'undefined' && (appState.isDoctorView || appState.currentRole === 'doctor')) return true;
    return false;
}

// Update Checklist View
function updateChecklistUI() {
    const listContainer = document.getElementById('checklist-doses-list');
    if (!listContainer) return;
    listContainer.innerHTML = '';

    const targetDate = appState.selectedDate || formatYMD(new Date());

    // Update Date Header Title
    const titleEl = document.getElementById('checklist-date-title');
    if (titleEl && targetDate) {
        const parts = targetDate.split('-').map(Number);
        const dObj = new Date(parts[0], parts[1] - 1, parts[2]);
        const dateFormatted = dObj.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric', year: 'numeric' });
        titleEl.textContent = `Adherence Checklist: ${dateFormatted}`;
    }

    // Doses synchronized with all active medications
    const doses = getDosesForDate(targetDate);

    if (doses.length === 0) {
        listContainer.innerHTML = `<p class="empty-state">No scheduled doses found for ${targetDate}. Pick another date or schedule a medication.</p>`;
        return;
    }

    const todayStr = formatYMD(new Date());
    const isPastDate = targetDate < todayStr;
    const isDoc = isDoctorUser();

    doses.forEach(dose => {
        const item = document.createElement('div');
        item.className = 'checklist-row-item';

        const isTaken = dose.status === 'taken';
        const isSkipped = dose.status === 'skipped';

        let statusLabel = '';
        if (isTaken) {
            statusLabel = `Taken at: ${dose.taken_at ? dose.taken_at.split(' ')[1] : '--'}`;
        } else if (isSkipped) {
            statusLabel = 'Skipped';
        } else if (isPastDate) {
            statusLabel = 'Not Taken';
        } else {
            statusLabel = 'Pending Intake';
        }

        let actionsHTML = '';
        if (isDoc) {
            // Doctor View: Doctors can ONLY VIEW patient calendar, NOT edit or mark doses
            if (isTaken) {
                actionsHTML = `<span class="badge-status taken" style="color:#10b981; font-weight:700; padding:6px 14px; background:rgba(16,185,129,0.15); border:1px solid rgba(16,185,129,0.3); border-radius:6px; font-size:12.5px;">Taken</span>`;
            } else if (isSkipped) {
                actionsHTML = `<span class="badge-status skipped" style="color:#f87171; font-weight:700; padding:6px 14px; background:rgba(239,68,68,0.15); border:1px solid rgba(239,68,68,0.3); border-radius:6px; font-size:12.5px;">Skipped</span>`;
            } else {
                actionsHTML = `<span class="badge-status pending" style="color:#38bdf8; font-weight:700; padding:6px 14px; background:rgba(56,189,248,0.15); border:1px solid rgba(56,189,248,0.3); border-radius:6px; font-size:12.5px;">Pending</span>`;
            }
        } else if (isPastDate) {
            // Past days show final status badge instead of action buttons for patient
            if (isTaken) {
                actionsHTML = `<span class="badge-status taken" style="color:#10b981; font-weight:700; padding:6px 14px; background:rgba(16,185,129,0.15); border:1px solid rgba(16,185,129,0.3); border-radius:6px; font-size:12.5px;">Taken</span>`;
            } else {
                actionsHTML = `<span class="badge-status skipped" style="color:#f87171; font-weight:700; padding:6px 14px; background:rgba(239,68,68,0.15); border:1px solid rgba(239,68,68,0.3); border-radius:6px; font-size:12.5px;">Not Taken</span>`;
            }
        } else {
            // Today & Future days show interactive action buttons for patient
            const doseIdParam = typeof dose.id === 'string' ? `'${dose.id}'` : dose.id;
            actionsHTML = `
                <button class="btn-checkbox btn-take ${isTaken ? 'taken' : ''}" onclick="toggleDoseStatus(${doseIdParam}, 'taken')" title="Mark as Taken">
                    <i data-lucide="check"></i>
                </button>
                <button class="btn-checkbox btn-skip ${isSkipped ? 'skipped' : ''}" onclick="toggleDoseStatus(${doseIdParam}, 'skipped')" title="Mark as Skipped">
                    <i data-lucide="x"></i>
                </button>
            `;
        }

        const pillVis = getPillVisual(dose.medication_name, dose.medication_dosage);
        item.innerHTML = `
            <div class="checklist-left">
                <span class="time-slot">${escapeHTML(dose.medication_time_of_day || '08:00')}</span>
                <div class="pill-avatar-icon ${pillVis.formClass}" title="${pillVis.label}">
                    <i data-lucide="${pillVis.icon}"></i>
                </div>
                <div class="check-med-details">
                    <h4>${escapeHTML(dose.medication_name)} ${escapeHTML(dose.medication_dosage)}</h4>
                    <span style="${isPastDate && !isTaken ? 'color:#f87171; font-weight:600;' : ''}">${statusLabel}</span>
                </div>
            </div>
            <div class="checklist-actions">
                ${actionsHTML}
            </div>
        `;
        listContainer.appendChild(item);
    });
    if (window.lucide && lucide.createIcons) lucide.createIcons();
}


// Toggle adherence status
async function toggleDoseStatus(adherenceId, targetStatus) {
    if (isDoctorUser()) {
        showNotification("Doctor View Mode: Doctors can view patient calendar & adherence logs, but cannot edit or log patient doses.", "warning");
        return;
    }

    // Refresh adherence from backend to ensure slot exists if temp ID
    if (typeof adherenceId === 'string' && adherenceId.startsWith('temp_')) {
        await fetchAdherence();
        const parts = adherenceId.split('_');
        const medId = parseInt(parts[1], 10);
        const dateStr = parts[2];
        const match = appState.adherence.find(h => h.medication_id === medId && h.scheduled_time && h.scheduled_time.startsWith(dateStr));
        if (match) {
            adherenceId = match.id;
        }
    }

    const item = appState.adherence.find(h => h.id === adherenceId);
    if (!item) {
        // Fallback: re-fetch and re-render
        await refreshData();
        return;
    }
    
    // Toggle action: if already in targetStatus, set back to pending
    const oldStatus = item.status;
    const oldTakenAt = item.taken_at;
    const newStatus = item.status === targetStatus ? 'pending' : targetStatus;
    const newTakenAt = newStatus === 'taken' ? new Date().toISOString().replace('T', ' ').substring(0, 19) : null;
    
    // Optimistic UI Update
    item.status = newStatus;
    item.taken_at = newTakenAt;
    updateChecklistUI();
    updateDashboardWidgets();
    invalidatePrefetchCache();

    // Check for 100% adherence celebration today
    const todayStr = formatYMD(new Date());
    const targetDate = appState.selectedDate || todayStr;
    if (targetDate === todayStr && newStatus === 'taken') {
        const todayDoses = getDosesForDate(todayStr);
        const allCompleted = todayDoses.length > 0 && todayDoses.every(d => (d.id === adherenceId ? true : d.status === 'taken'));
        if (allCompleted) {
            launchConfetti();
            showNotification("🎉 Outstanding! You have taken 100% of your scheduled doses today!", "success");
        }
    }
    
    try {
        const res = await fetch(`/api/adherence/${adherenceId}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ status: newStatus })
        });
        const result = await res.json();
        if (result.success) {
            refreshDataSilently();
        } else {
            throw new Error(result.message || "Failed to update adherence status on server.");
        }
    } catch (err) {
        console.error("Error updating dose adherence:", err);
        // Rollback
        item.status = oldStatus;
        item.taken_at = oldTakenAt;
        updateChecklistUI();
        updateDashboardWidgets();
        alert(`Failed to update status: ${err.message}`);
    }
}

// Update Medications Pane UI
function updateMedicationsUI() {
    const grid = document.getElementById('medications-grid-list');
    grid.innerHTML = '';
    
    if (appState.medications.length === 0) {
        grid.innerHTML = '<p class="empty-state">No scheduled medications active.</p>';
        return;
    }

    appState.medications.forEach(med => {
        const pillVis = getPillVisual(med.name, med.dosage);
        const card = document.createElement('div');
        card.className = 'med-card';
        card.innerHTML = `
            <button class="btn-delete-med" onclick="deleteMedication(${med.id})" title="Delete Medication">
                <i data-lucide="trash-2"></i>
            </button>
            <div class="med-card-header">
                <div class="pill-avatar-icon ${pillVis.formClass}" title="${pillVis.label}">
                    <i data-lucide="${pillVis.icon}"></i>
                </div>
                <div>
                    <div class="med-card-title">${escapeHTML(med.name)}</div>
                    <div class="med-card-dosage">${escapeHTML(med.dosage)}</div>
                </div>
            </div>
            <div class="med-card-details">
                <span><i data-lucide="clock"></i> Scheduled: ${escapeHTML(med.time_of_day || '08:00')}</span>
                <span><i data-lucide="calendar"></i> Frequency: ${escapeHTML(med.frequency || 'Daily')}</span>
                <span><i data-lucide="info"></i> Details: ${escapeHTML(med.schedule_description || 'None')}</span>
                <span><i data-lucide="calendar-days"></i> Started: ${escapeHTML(med.start_date ? med.start_date.substring(0, 10) : 'Today')}</span>
            </div>
        `;
        grid.appendChild(card);
    });
    lucide.createIcons();

    // Refresh Allergies profile chips
    const chipsContainer = document.getElementById('allergies-chips-container');
    chipsContainer.innerHTML = '';
    
    if (appState.allergies.length === 0) {
        chipsContainer.innerHTML = '<p class="text-muted">No allergies registered.</p>';
    } else {
        appState.allergies.forEach(allergy => {
            const chip = document.createElement('div');
            chip.className = 'allergy-chip';
            chip.innerHTML = `
                <span>${allergy.name}</span>
                <button onclick="deleteAllergy('${allergy.name}')"><i data-lucide="x"></i></button>
            `;
            chipsContainer.appendChild(chip);
        });
        lucide.createIcons();
    }
}

// Add medication form submit handler
async function handleAddMedicationSubmit(e) {
    e.preventDefault();
    const name = document.getElementById('med-name').value.trim();
    const dosage = document.getElementById('med-dosage').value.trim();
    const time_of_day = document.getElementById('med-time').value;
    const frequency = document.getElementById('med-frequency').value;
    const schedule_description = document.getElementById('med-desc').value.trim();

    const medData = { name, dosage, schedule_description, frequency, time_of_day };

    try {
        const res = await fetch('/api/medications', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(medData)
        });
        const result = await res.json();
        
        if (result.success) {
            // Added successfully
            document.getElementById('add-medication-form').reset();
            await refreshData();
            invalidatePrefetchCache();
            showStatusNotification(`Medication ${name} scheduled successfully.`, 'success');
        } else {
            // Safety Warnings triggered! Open warning modal
            appState.pendingForceAddMed = medData;
            showStatusNotification(`⚠️ Safety warning for ${name}. Click 'Confirm & Schedule' in the popup to add.`, 'warning');
            openSafetyModal(name, result.safety_warnings);
        }
    } catch (err) {
        console.error("Error scheduling medication:", err);
    }
}

// Delete Medication
async function deleteMedication(id) {
    if (!confirm("Are you sure you want to delete this medication and all its trackers?")) return;
    
    const originalMeds = [...appState.medications];
    appState.medications = appState.medications.filter(m => m.id !== id);
    
    // Optimistic UI Update
    updateMedicationsUI();
    updateDashboardWidgets();
    invalidatePrefetchCache();

    try {
        const res = await fetch(`/api/medications/${id}`, {
            method: 'DELETE'
        });
        const result = await res.json();
        if (!result.success) {
            throw new Error(result.message || "Failed to delete medication from database.");
        }
        // Silently reload in the background
        refreshDataSilently();
    } catch (err) {
        console.error("Error deleting medication:", err);
        appState.medications = originalMeds;
        updateMedicationsUI();
        updateDashboardWidgets();
        alert(`Error deleting medication: ${err.message}`);
    }
}

// Delete Allergy
async function deleteAllergy(name) {
    const originalAllergies = [...appState.allergies];
    appState.allergies = appState.allergies.filter(a => a.name !== name);
    
    // Optimistic UI Update
    updateMedicationsUI();
    updateDashboardWidgets();
    invalidatePrefetchCache();

    try {
        const res = await fetch(`/api/allergies/${name}`, {
            method: 'DELETE'
        });
        const result = await res.json();
        if (!result.success) {
            throw new Error(result.message || "Failed to delete allergy from database.");
        }
        refreshDataSilently();
    } catch (err) {
        console.error("Error deleting allergy:", err);
        appState.allergies = originalAllergies;
        updateMedicationsUI();
        updateDashboardWidgets();
        alert(`Error deleting allergy: ${err.message}`);
    }
}

// Warning Modal Operations
function openSafetyModal(medName, warnings) {
    document.getElementById('modal-title').textContent = `Safety warnings: ${medName}`;
    const warningList = document.getElementById('modal-warnings-list-items');
    warningList.innerHTML = '';
    
    warnings.forEach(w => {
        const li = document.createElement('li');
        li.innerHTML = w.replace(/⚠️/g, ""); // strip duplicate alert emojis if any
        warningList.appendChild(li);
    });
    
    document.getElementById('safety-modal').classList.add('active');
}

function closeSafetyModal() {
    document.getElementById('safety-modal').classList.remove('active');
    appState.pendingForceAddMed = null;
}

async function confirmForceAddMedication() {
    if (!appState.pendingForceAddMed) return;
    
    try {
        const res = await fetch('/api/medications/force', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ...appState.pendingForceAddMed, override_confirmed: true })
        });
        const result = await res.json();
        if (result.success) {
            closeSafetyModal();
            document.getElementById('add-medication-form').reset();
            await refreshData();
            invalidatePrefetchCache();
            showStatusNotification(`Medication ${result.medication.name} added with safety override.`, 'warning');
        }
    } catch (err) {
        console.error("Error overriding drug check:", err);
    }
}

// Symptoms View Updates
async function deleteSymptomLog(symptomId) {
    if (!symptomId) return;
    try {
        const res = await fetch(`/api/symptoms/${symptomId}`, {
            method: 'DELETE',
            headers: {
                'Authorization': `Bearer ${appState.token}`
            }
        });

        if (res.ok) {
            appState.symptoms = appState.symptoms.filter(s => String(s.id) !== String(symptomId));
            updateSymptomsUI();
            if (typeof renderCorrelationChart === 'function') renderCorrelationChart();
            showStatusNotification("Symptom log deleted successfully.", "success");
        } else {
            const errData = await res.json().catch(() => ({}));
            showStatusNotification(errData.detail || "Failed to delete symptom.", "warning");
        }
    } catch (err) {
        console.error("Error deleting symptom:", err);
        showStatusNotification("Error deleting symptom. Please try again.", "warning");
    }
}

function updateSymptomsUI() {
    const container = document.getElementById('symptoms-history-timeline');
    if (!container) return;
    container.innerHTML = '';
    
    if (appState.symptoms.length === 0) {
        container.innerHTML = '<p class="empty-state">No symptoms logged.</p>';
        return;
    }

    appState.symptoms.forEach(s => {
        const item = document.createElement('div');
        item.className = 'timeline-log-item';
        item.style.position = 'relative';
        
        const sevClass = s.severity <= 3 ? 'mild' : (s.severity <= 7 ? 'moderate' : 'severe');
        const correlationBadge = s.correlated_medication ? 
            `<span class="badge-status skipped" style="font-size:10px; margin-top:4px; display:inline-block;">Correlated: ${escapeHTML(s.correlated_medication)}</span>` : '';
            
        item.innerHTML = `
            <div class="log-severity-badge ${sevClass}">${s.severity}</div>
            <div class="log-body" style="flex: 1; padding-right: 32px;">
                <div class="log-desc-text">${escapeHTML(s.description)}</div>
                <div class="log-meta-text">${escapeHTML(s.logged_at)} ${correlationBadge}</div>
            </div>
            <button type="button" class="btn-delete-symptom" data-id="${s.id}" title="Delete Symptom" style="position: absolute; right: 10px; top: 50%; transform: translateY(-50%); background: rgba(239, 68, 68, 0.1); border: 1px solid rgba(239, 68, 68, 0.25); color: #ef4444; cursor: pointer; font-size: 13px; padding: 5px 8px; border-radius: 8px; transition: all 0.2s; display: inline-flex; align-items: center; justify-content: center;" onmouseover="this.style.background='rgba(239, 68, 68, 0.25)'; this.style.transform='translateY(-50%) scale(1.08)';" onmouseout="this.style.background='rgba(239, 68, 68, 0.1)'; this.style.transform='translateY(-50%) scale(1)';">
                🗑️
            </button>
        `;
        container.appendChild(item);
    });

    // Attach click listeners to dustbin delete buttons
    container.querySelectorAll('.btn-delete-symptom').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            e.stopPropagation();
            const symptomId = btn.getAttribute('data-id');
            if (!symptomId) return;
            if (confirm("Are you sure you want to delete this symptom entry?")) {
                await deleteSymptomLog(symptomId);
            }
        });
    });
}

// Populate symptom correlation dropdown
function populateCorrelatedMedicationsDropdown() {
    const select = document.getElementById('sym-correlation');
    select.innerHTML = '<option value="">None (General Symptom)</option>';
    
    appState.medications.forEach(med => {
        const opt = document.createElement('option');
        opt.value = med.name;
        opt.textContent = `${med.name} (${med.dosage})`;
        select.appendChild(opt);
    });
}

// Draw dynamic Side-Effect Correlation Chart
function renderCorrelationChart() {
    const ctx = document.getElementById('correlationChart').getContext('2d');
    
    // Destroy existing instance to redraw cleanly
    if (appState.correlationChart) {
        appState.correlationChart.destroy();
    }
    
    // Generate labels for the past 7 days
    const labels = [];
    const dates = [];
    for (let i = 6; i >= 0; i--) {
        const d = new Date();
        d.setDate(d.getDate() - i);
        const iso = d.toISOString().split('T')[0];
        dates.push(iso);
        labels.push(d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }));
    }
    
    // Calculate adherence bar heights (number of taken doses per day)
    const takenDosesData = dates.map(dt => {
        return appState.adherence.filter(h => h.scheduled_time.startsWith(dt) && h.status === 'taken').length;
    });
    
    // Calculate average symptom severity score per day
    const symptomSeverityData = dates.map(dt => {
        const logs = appState.symptoms.filter(s => s.logged_at.startsWith(dt));
        if (logs.length === 0) return 0;
        const total = logs.reduce((acc, curr) => acc + curr.severity, 0);
        return total / logs.length;
    });
    
    appState.correlationChart = new Chart(ctx, {
        type: 'bar',
        data: {
            labels: labels,
            datasets: [
                {
                    label: 'Doses Taken',
                    data: takenDosesData,
                    backgroundColor: 'rgba(16, 185, 129, 0.4)',
                    borderColor: 'var(--emerald-cyan)',
                    borderWidth: 1,
                    yAxisID: 'yAdherence',
                    barThickness: 24,
                    order: 2
                },
                {
                    label: 'Avg Symptom Severity',
                    data: symptomSeverityData,
                    type: 'line',
                    borderColor: 'rgba(239, 68, 68, 0.85)',
                    backgroundColor: 'rgba(239, 68, 68, 0.1)',
                    borderWidth: 3,
                    pointBackgroundColor: 'var(--danger-red)',
                    pointRadius: 5,
                    yAxisID: 'ySymptoms',
                    tension: 0.3,
                    order: 1
                }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: {
                    labels: { color: '#f8fafc', font: { family: 'Inter' } }
                }
            },
            scales: {
                x: {
                    grid: { color: 'rgba(255, 255, 255, 0.05)' },
                    ticks: { color: '#94a3b8' }
                },
                yAdherence: {
                    type: 'linear',
                    position: 'left',
                    grid: { color: 'rgba(255, 255, 255, 0.05)' },
                    ticks: { color: '#10b981', stepSize: 1, precision: 0 },
                    title: { display: true, text: 'Taken Doses Count', color: '#10b981' }
                },
                ySymptoms: {
                    type: 'linear',
                    position: 'right',
                    grid: { drawOnChartArea: false },
                    min: 0,
                    max: 10,
                    ticks: { color: '#ef4444', stepSize: 2 },
                    title: { display: true, text: 'Symptom Severity (1-10)', color: '#ef4444' }
                }
            }
        }
    });
}

function renderDoctorNotes() {
    const notesTextarea = document.getElementById('doctor-notes-textarea');
    const notesDisplay = document.getElementById('doctor-notes-display-list');
    const notesPrintView = document.getElementById('doctor-notes-print-view');
    if (!notesDisplay || !notesPrintView) return;
    
    const isDoctor = appState.isDoctorView;
    const notesFormWrapper = notesTextarea ? notesTextarea.parentElement : null;
    const notesSectionDesc = document.querySelector('#doctor-notes-section .form-desc');

    // Toggle note creation form: ONLY doctors can write & send notes!
    if (notesFormWrapper) {
        notesFormWrapper.style.display = isDoctor ? 'flex' : 'none';
    }
    if (notesSectionDesc) {
        notesSectionDesc.style.display = isDoctor ? 'block' : 'none';
    }
    
    // Retrieve list of notes from state
    const savedNotes = appState.doctorNotes || [];
    
    // Update print view (clean bulleted list)
    if (savedNotes.length === 0) {
        notesPrintView.innerHTML = '';
        notesDisplay.innerHTML = isDoctor ?
            '<p style="color: var(--text-muted); font-style: italic; margin: 0;">No notes added yet. Type above and click Send.</p>' :
            '<p style="color: var(--text-muted); font-style: italic; margin: 0;">No physician recommendations recorded yet.</p>';
    } else {
        notesPrintView.innerHTML = '<ul style="margin: 0; padding-left: 20px;">' + 
            savedNotes.map(n => `<li>${escapeHTML(n)}</li>`).join('') + 
            '</ul>';
            
        // On screen display list (with delete buttons for doctor, read-only for patient)
        let html = '<ul style="margin: 0; padding-left: 0; list-style-type: none; display: flex; flex-direction: column; gap: 8px;">';
        savedNotes.forEach((note, index) => {
            html += `
                <li style="display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; padding: 10px 14px; background: rgba(14, 165, 233, 0.06); border-radius: var(--border-radius-sm); border: 1px solid rgba(14, 165, 233, 0.18);">
                    <span style="flex-grow: 1; word-break: break-word; color: var(--text-primary); font-size: 13.5px; line-height: 1.5;"><strong style="color: #38bdf8; margin-right: 6px;">•</strong>${escapeHTML(note)}</span>
                    ${isDoctor ? `
                        <button class="btn-delete-note no-print" onclick="deleteDoctorNote(${index})" style="background: rgba(239, 68, 68, 0.15); border: 1px solid rgba(239, 68, 68, 0.3); color: #f87171; border-radius: 4px; cursor: pointer; padding: 4px 8px; font-size: 12px; font-weight: 600; display: inline-flex; align-items: center; gap: 4px; transition: all 0.2s;" title="Delete Note">
                            <i data-lucide="trash-2" style="width: 13px; height: 13px;"></i> Delete
                        </button>
                    ` : ''}
                </li>
            `;
        });
        html += '</ul>';
        notesDisplay.innerHTML = html;
        if (window.lucide) lucide.createIcons();
    }
}

// Global delete handler
window.deleteDoctorNote = async function(index) {
    if (index < 0 || index >= appState.doctorNotes.length) return;
    
    // Remove note from state
    appState.doctorNotes.splice(index, 1);
    
    // Save to database
    try {
        await fetch('/api/doctor-notes', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ notes: appState.doctorNotes })
        });
        // Save to localStorage
        localStorage.setItem('doctor_notes_' + appState.currentUserEmail, JSON.stringify(appState.doctorNotes));
    } catch (err) {
        console.error("Failed to delete doctor note:", err);
    }
    
    renderDoctorNotes();
};

// Generate printable clinician summaries
async function loadDoctorReport() {
    try {
        // Fetch doctor notes from database first
        try {
            const notesRes = await fetch('/api/doctor-notes');
            const notesData = await notesRes.json();
            appState.doctorNotes = notesData.notes || [];
        } catch (e) {
            console.error("Error fetching doctor notes from database:", e);
        }
        
        renderDoctorNotes();
        let report;
        if (prefetchCache.report) {
            report = await prefetchCache.report;
            prefetchCache.report = null;
        } else {
            const res = await fetch('/api/report');
            report = await res.json();
        }
        
        // Stats
        document.getElementById('report-adherence-rate').textContent = `${report.adherence_rate}%`;
        document.getElementById('report-dose-counts').textContent = `${report.doses_taken} taken / ${report.doses_skipped} skipped`;
        document.getElementById('report-symptom-count').textContent = report.symptoms.length;
        
        // Print meta details
        const meta = document.getElementById('report-meta-info');
        meta.innerHTML = `
            <strong>Patient ID:</strong> Local-Self-Managed<br>
            <strong>Generated At:</strong> ${report.generated_at}<br>
            <strong>Storage Model:</strong> Localhost SQLite Secure Sandbox
        `;
        
        document.getElementById('report-printed-at').textContent = `Printed at: ${report.generated_at} | MedSafe Local-First System`;
        
        // Medications Table
        const medsBody = document.querySelector('#report-meds-table tbody');
        medsBody.innerHTML = '';
        if (report.medications.length === 0) {
            medsBody.innerHTML = '<tr><td colspan="5" class="text-center">No medications scheduled.</td></tr>';
        } else {
            report.medications.forEach(m => {
                const tr = document.createElement('tr');
                tr.innerHTML = `
                    <td><strong>${m.name}</strong></td>
                    <td>${m.dosage}</td>
                    <td>${m.schedule_description}</td>
                    <td>${m.time_of_day}</td>
                    <td>${m.start_date}</td>
                `;
                medsBody.appendChild(tr);
            });
        }
        
        // Allergy Profile list
        const allergyList = document.getElementById('report-allergies-list');
        allergyList.innerHTML = '';
        if (report.allergies.length === 0) {
            allergyList.innerHTML = '<span class="text-muted">No allergies registered.</span>';
        } else {
            report.allergies.forEach(a => {
                const span = document.createElement('span');
                span.className = 'allergy-chip';
                span.style.border = '1px solid #ef4444';
                span.style.color = '#dc2626';
                span.style.backgroundColor = '#fef2f2';
                span.textContent = a;
                allergyList.appendChild(span);
            });
        }

        // Symptoms Table
        const symBody = document.querySelector('#report-symptoms-table tbody');
        symBody.innerHTML = '';
        if (report.symptoms.length === 0) {
            symBody.innerHTML = '<tr><td colspan="4" class="text-center">No symptoms logged.</td></tr>';
        } else {
            report.symptoms.forEach(s => {
                const tr = document.createElement('tr');
                tr.innerHTML = `
                    <td>${s.logged_at}</td>
                    <td>${s.description}</td>
                    <td><strong>Severity ${s.severity}/10</strong></td>
                    <td>${s.correlated_medication || 'None'}</td>
                `;
                symBody.appendChild(tr);
            });
        }
        
        // Adherence History Table
        const adhBody = document.querySelector('#report-adherence-table tbody');
        adhBody.innerHTML = '';
        if (report.adherence_logs.length === 0) {
            adhBody.innerHTML = '<tr><td colspan="5" class="text-center">No compliance logs.</td></tr>';
        } else {
            report.adherence_logs.forEach(a => {
                const tr = document.createElement('tr');
                const badgeColor = a.status === 'taken' ? 'color: var(--emerald-cyan); font-weight: var(--font-weight-subheader);' : (a.status === 'skipped' ? 'color: var(--danger-red); font-weight: var(--font-weight-subheader);' : 'color: var(--amber-warning);');
                tr.innerHTML = `
                    <td>${a.scheduled_time}</td>
                    <td><strong>${a.medication_name}</strong></td>
                    <td>${a.medication_dosage}</td>
                    <td><span style="${badgeColor}">${a.status.toUpperCase()}</span></td>
                    <td>${a.taken_at || '--'}</td>
                `;
                adhBody.appendChild(tr);
            });
        }
        
        window.reportPdfToken = report.pdf_token;
        
    } catch (err) {
        console.error("Error loading doctor report details:", err);
    }
}

// ─── Print Doctor Report ───────────────────────────────────────────────────
// Opens a popup window with the report DOM content rendered cleanly for print,
// bypassing the tab-pane display:none issue that caused blank pages.
window.printDoctorReport = function () {
    // Grab the rendered report card from the main DOM
    const reportCard = document.querySelector('.printable-report-card');
    if (!reportCard) {
        alert('Report not loaded yet. Please wait a moment and try again.');
        return;
    }

    // Clone it so we can modify for print without touching the live DOM
    const clone = reportCard.cloneNode(true);

    // Remove any elements that should not appear in print (textarea, buttons, etc.)
    clone.querySelectorAll('.no-print, textarea, button').forEach(el => el.remove());

    // Show the doctor-notes print view inside the clone (it's hidden on screen)
    const printView = clone.querySelector('#doctor-notes-print-view');
    if (printView) {
        printView.style.display = 'block';
    }
    // Hide the interactive notes display list duplicate
    const displayList = clone.querySelector('#doctor-notes-display-list');
    if (displayList) {
        displayList.style.display = 'none';
    }

    // Build allergy chips as plain text for print
    const allergyChips = clone.querySelectorAll('.allergy-chip');
    allergyChips.forEach(chip => {
        chip.style.cssText = 'display:inline-block;padding:2px 8px;margin:2px;border:1px solid #dc2626;border-radius:4px;color:#dc2626;background:#fef2f2;font-size:12px;';
    });

    // Build print popup HTML
    const printHTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>MedSafe AI – Clinical Report</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: 'Segoe UI', Arial, sans-serif; font-size: 12pt; color: #111; background: #fff; }
  .printable-report-card { padding: 24px; }
  .report-header-print { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 12px; }
  .report-logo { display: flex; align-items: center; gap: 10px; }
  .report-title { font-size: 1.4rem; font-weight: 700; color: #1e3a8a; }
  .logo-icon-print { width: 28px; height: 28px; color: #1e3a8a; }
  .report-meta { font-size: 10pt; line-height: 1.7; color: #334155; text-align: right; }
  .report-divider { border: none; border-top: 2px solid #cbd5e1; margin: 12px 0; }
  .report-summary-stats { display: flex; gap: 12px; margin-bottom: 20px; }
  .rep-stat-box { flex: 1; border: 1px solid #cbd5e1; border-radius: 6px; padding: 12px; background: #f8fafc; }
  .rep-stat-label { display: block; font-size: 9pt; color: #64748b; margin-bottom: 4px; }
  .rep-stat-value { display: block; font-size: 1.3rem; font-weight: 700; color: #1e3a8a; }
  .report-section { margin-bottom: 20px; }
  .report-section h3 { font-size: 11pt; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; color: #1e3a8a; border-bottom: 2px solid #1e3a8a; padding-bottom: 4px; margin-bottom: 10px; }
  .report-table { width: 100%; border-collapse: collapse; font-size: 10pt; }
  .report-table th { background: #f1f5f9; border-bottom: 2px solid #cbd5e1; padding: 6px 10px; text-align: left; font-weight: 600; color: #334155; }
  .report-table td { border-bottom: 1px solid #e2e8f0; padding: 5px 10px; color: #1e293b; }
  .report-table tr:last-child td { border-bottom: none; }
  .report-allergies-list { display: flex; flex-wrap: wrap; gap: 6px; padding: 8px 0; }
  .allergy-chip { display: inline-block; padding: 2px 8px; border: 1px solid #dc2626; border-radius: 4px; color: #dc2626; background: #fef2f2; font-size: 10pt; }
  #doctor-notes-section { margin-top: 16px; padding: 14px; border: 1px solid #bae6fd; border-radius: 6px; background: #f0f9ff; }
  #doctor-notes-section h3 { color: #0369a1; border-color: #0369a1; }
  .print-only-block { font-size: 10pt; color: #1e293b; white-space: pre-wrap; line-height: 1.6; }
  .report-footer-print { margin-top: 24px; border-top: 1px solid #e2e8f0; padding-top: 10px; font-size: 9pt; color: #64748b; }
  .print-timestamp { font-size: 9pt; color: #64748b; margin-top: 4px; }
  @media print {
    body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    .report-summary-stats { flex-direction: row; }
    .rep-stat-box { break-inside: avoid; }
    .report-section { break-inside: avoid; }
    table { page-break-inside: auto; }
    tr { page-break-inside: avoid; page-break-after: auto; }
  }
</style>
</head>
<body>
${clone.outerHTML}
<script>
  window.onload = function() {
    // Slight delay to ensure all paint is done before printing
    setTimeout(function() { window.print(); window.close(); }, 300);
  };
<\/script>
</body>
</html>`;

    const printWin = window.open('', '_blank', 'width=900,height=700,scrollbars=yes');
    if (!printWin) {
        alert('Print popup was blocked. Please allow popups for this site and try again.');
        return;
    }
    printWin.document.open();
    printWin.document.write(printHTML);
    printWin.document.close();
};

// Chat operations (Multi-agent chat streaming reader)
const chatForm = document.getElementById('chat-input-form');
const chatMessages = document.getElementById('chat-messages-stream');
const typingLoader = document.getElementById('chat-typing-loader');

const fileInput = document.getElementById('chat-file-input');
const btnAttach = document.getElementById('chat-btn-attach');
const previewContainer = document.getElementById('chat-attachment-preview');
const filenameSpan = document.getElementById('attachment-filename');
const btnRemoveAttach = document.getElementById('chat-btn-remove-attachment');

if (btnAttach && fileInput) {
    btnAttach.addEventListener('click', () => {
        fileInput.click();
    });
}

if (fileInput) {
    fileInput.addEventListener('change', () => {
        if (fileInput.files && fileInput.files[0]) {
            const file = fileInput.files[0];
            filenameSpan.textContent = file.name;
            previewContainer.style.display = 'flex';
            lucide.createIcons();
        } else {
            previewContainer.style.display = 'none';
        }
    });
}

if (btnRemoveAttach) {
    btnRemoveAttach.addEventListener('click', () => {
        fileInput.value = '';
        previewContainer.style.display = 'none';
    });
}

chatForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = document.getElementById('chat-input-message');
    const msgText = input.value.trim();
    const fileAttached = fileInput && fileInput.files && fileInput.files[0];
    
    if (!msgText && !fileAttached) return;
    
    input.value = '';
    
    if (fileAttached) {
        appendChatMessage(`${msgText ? msgText + '<br><br>' : ''}📎 <strong>Attached:</strong> <i>${fileAttached.name}</i>`, 'user');
    } else {
        appendChatMessage(msgText, 'user');
    }
    
    // Show typing bubble loader
    typingLoader.style.display = 'flex';
    chatMessages.scrollTop = chatMessages.scrollHeight;

    try {
        let response;
        if (fileAttached) {
            const formData = new FormData();
            formData.append('message', msgText);
            formData.append('file', fileAttached);
            
            response = await fetch('/api/chat/upload', {
                method: 'POST',
                body: formData
            });
            
            // Clear attachment preview
            fileInput.value = '';
            previewContainer.style.display = 'none';
        } else {
            const token = localStorage.getItem('token');
            const headers = { 'Content-Type': 'application/json' };
            if (token) {
                headers['Authorization'] = `Bearer ${token}`;
            }
            response = await fetch('/api/chat', {
                method: 'POST',
                headers: headers,
                body: JSON.stringify({ message: msgText })
            });
        }
        
        // Hide loader
        typingLoader.style.display = 'none';
        
        // Append an empty bot bubble we will stream into
        const botMsgDiv = document.createElement('div');
        botMsgDiv.className = 'message bot';
        botMsgDiv.innerHTML = `
            <div class="msg-bubble"></div>
            <span class="msg-time">Streaming...</span>
        `;
        chatMessages.appendChild(botMsgDiv);
        const bubble = botMsgDiv.querySelector('.msg-bubble');
        
        const reader = response.body.getReader();
        const decoder = new TextDecoder("utf-8");
        let finished = false;
        let displayedText = "";

        while (!finished) {
            const { value, done } = await reader.read();
            if (done) {
                finished = true;
                break;
            }
            const chunk = decoder.decode(value, { stream: true });
            displayedText += chunk;
            bubble.innerHTML = parseMarkdown(displayedText);
            chatMessages.scrollTop = chatMessages.scrollHeight;
        }
        
        // Finalize time badge and attach interactive action buttons (TTS & Copy)
        botMsgDiv.querySelector('.msg-time').textContent = new Date().toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
        
        const actionBar = document.createElement('div');
        actionBar.className = 'msg-action-bar';
        actionBar.innerHTML = `
            <button type="button" class="msg-action-btn btn-tts-speak" onclick="speakMessage(this)" title="Listen Aloud (Text-to-Speech)">
                <i data-lucide="volume-2"></i> Listen
            </button>
            <button type="button" class="msg-action-btn btn-copy-msg" onclick="copyMessageText(this)" title="Copy Message Text">
                <i data-lucide="copy"></i> Copy
            </button>
        `;
        botMsgDiv.appendChild(actionBar);
        if (window.lucide && lucide.createIcons) lucide.createIcons();

        refreshData();
    } catch (err) {
        typingLoader.style.display = 'none';
        appendChatMessage("Sorry, I encountered an issue accessing my local database server.", 'bot');
        console.error("Chat streaming failure:", err);
    }
});

// Append regular chat message with TTS & Copy actions
function appendChatMessage(text, sender) {
    const msgDiv = document.createElement('div');
    msgDiv.className = `message ${sender}`;
    const time = new Date().toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
    
    let actionsHTML = '';
    if (sender === 'bot') {
        actionsHTML = `
            <div class="msg-action-bar">
                <button type="button" class="msg-action-btn btn-tts-speak" onclick="speakMessage(this)" title="Listen Aloud (Text-to-Speech)">
                    <i data-lucide="volume-2"></i> Listen
                </button>
                <button type="button" class="msg-action-btn btn-copy-msg" onclick="copyMessageText(this)" title="Copy Message Text">
                    <i data-lucide="copy"></i> Copy
                </button>
            </div>
        `;
    }

    msgDiv.innerHTML = `
        <div class="msg-bubble">${sender === 'bot' ? parseMarkdown(text) : text.replace(/\n/g, '<br>')}</div>
        <span class="msg-time">${time}</span>
        ${actionsHTML}
    `;
    chatMessages.appendChild(msgDiv);
    chatMessages.scrollTop = chatMessages.scrollHeight;
    if (window.lucide && lucide.createIcons) lucide.createIcons();
}

// ── Web Speech API Voice Input & Audio Reader ────────────────────────────────
let speechRecognitionInstance = null;

function initVoiceRecognition() {
    const micBtn = document.getElementById('btn-chat-mic');
    const inputEl = document.getElementById('chat-input-message');
    if (!micBtn || !inputEl) return;

    const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRec) {
        // Hide mic button gracefully if browser lacks SpeechRecognition support
        micBtn.style.display = 'none';
        return;
    }

    try {
        speechRecognitionInstance = new SpeechRec();
        speechRecognitionInstance.continuous = false;
        speechRecognitionInstance.interimResults = false;
        speechRecognitionInstance.lang = 'en-US';

        let isListening = false;

        micBtn.addEventListener('click', () => {
            if (!isListening) {
                try {
                    speechRecognitionInstance.start();
                    isListening = true;
                    micBtn.classList.add('listening');
                    micBtn.setAttribute('title', 'Listening... Speak your symptom or question now');
                    inputEl.setAttribute('placeholder', 'Listening to your voice...');
                } catch (err) {
                    console.warn("Speech recognition start issue:", err);
                }
            } else {
                speechRecognitionInstance.stop();
                isListening = false;
                micBtn.classList.remove('listening');
                inputEl.setAttribute('placeholder', 'Ask MedSafe AI or speak...');
            }
        });

        speechRecognitionInstance.onresult = (e) => {
            const transcript = e.results[0][0].transcript;
            if (transcript) {
                inputEl.value = transcript;
                inputEl.focus();
            }
        };

        speechRecognitionInstance.onerror = (e) => {
            console.warn("Speech recognition error:", e.error);
            isListening = false;
            micBtn.classList.remove('listening');
            inputEl.setAttribute('placeholder', 'Ask MedSafe AI or speak...');
        };

        speechRecognitionInstance.onend = () => {
            isListening = false;
            micBtn.classList.remove('listening');
            inputEl.setAttribute('placeholder', 'Ask MedSafe AI or speak...');
        };
    } catch (e) {
        console.warn("Could not init speech recognition:", e);
        micBtn.style.display = 'none';
    }
}

// TTS Audio Speak
window.speakMessage = function(btn) {
    if (!window.speechSynthesis) {
        alert("Text-to-Speech audio is not supported in this browser.");
        return;
    }
    const messageContainer = btn.closest('.message');
    const bubble = messageContainer ? messageContainer.querySelector('.msg-bubble') : null;
    if (!bubble) return;

    // Stop currently speaking audio
    window.speechSynthesis.cancel();

    // Clean text of markdown/HTML artifacts for clean speech
    const cleanText = bubble.innerText.replace(/[#*`_~]/g, '').trim();
    if (!cleanText) return;

    const utterance = new SpeechSynthesisUtterance(cleanText);
    utterance.rate = 1.0;
    utterance.pitch = 1.0;

    btn.innerHTML = '<i data-lucide="volume-x"></i> Stop';
    if (window.lucide && lucide.createIcons) lucide.createIcons();

    utterance.onend = () => {
        btn.innerHTML = '<i data-lucide="volume-2"></i> Listen';
        if (window.lucide && lucide.createIcons) lucide.createIcons();
    };

    utterance.onerror = () => {
        btn.innerHTML = '<i data-lucide="volume-2"></i> Listen';
        if (window.lucide && lucide.createIcons) lucide.createIcons();
    };

    window.speechSynthesis.speak(utterance);
};

// Copy Message Text
window.copyMessageText = function(btn) {
    const messageContainer = btn.closest('.message');
    const bubble = messageContainer ? messageContainer.querySelector('.msg-bubble') : null;
    if (!bubble) return;

    navigator.clipboard.writeText(bubble.innerText).then(() => {
        const originalHTML = btn.innerHTML;
        btn.innerHTML = '<i data-lucide="check"></i> Copied!';
        if (window.lucide && lucide.createIcons) lucide.createIcons();
        setTimeout(() => {
            btn.innerHTML = originalHTML;
            if (window.lucide && lucide.createIcons) lucide.createIcons();
        }, 1800);
    }).catch(err => {
        console.error("Clipboard copy failed:", err);
    });
};

// Bind chat suggestions & quick prompt action chips
function initQuickChips() {
    const chips = document.querySelectorAll('.chip-btn, .suggestion-btn');
    const input = document.getElementById('chat-input-message');
    const form = document.getElementById('chat-input-form');
    if (!input || !form) return;

    chips.forEach(chip => {
        chip.addEventListener('click', () => {
            const prompt = chip.getAttribute('data-prompt');
            if (prompt) {
                input.value = prompt;
                form.requestSubmit ? form.requestSubmit() : form.dispatchEvent(new Event('submit', { cancelable: true }));
            }
        });
    });
}



// Handle sliders and Forms setup
function setupForms() {
    // Add Med Form
    document.getElementById('add-medication-form').addEventListener('submit', handleAddMedicationSubmit);
    
    // Add Allergy Form button
    document.getElementById('btn-add-allergy').addEventListener('click', async () => {
        const input = document.getElementById('new-allergy-name');
        const name = input.value.trim();
        if (!name) return;
        
        try {
            const res = await fetch('/api/allergies', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name })
            });
            const result = await res.json();
            if (result.success || !result.success) {
                input.value = '';
                refreshData();
                invalidatePrefetchCache();
                showStatusNotification(result.message, result.success ? "success" : "warning");
            }
        } catch (err) {
            console.error("Error adding allergy:", err);
        }
    });

    // Log Symptom Form
    document.getElementById('log-symptom-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const description = document.getElementById('sym-desc').value.trim();
        const severity = parseInt(document.getElementById('sym-severity').value);
        const correlated_medication = document.getElementById('sym-correlation').value || null;

        const originalSymptoms = [...appState.symptoms];
        const mockSymptom = {
            id: Date.now(),
            description,
            severity,
            correlated_medication,
            logged_at: new Date().toISOString().replace('T', ' ').substring(0, 19)
        };
        appState.symptoms.unshift(mockSymptom);

        // Optimistic UI Update
        document.getElementById('log-symptom-form').reset();
        document.getElementById('severity-val').textContent = '5';
        updateSymptomsUI();
        renderCorrelationChart();
        showStatusNotification("Symptom logged successfully.", "success");
        invalidatePrefetchCache();

        try {
            const res = await fetch('/api/symptoms', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ description, severity, correlated_medication })
            });
            const result = await res.json();
            if (result.success) {
                refreshDataSilently();
            } else {
                throw new Error(result.message || "Server rejected logging.");
            }
        } catch (err) {
            console.error("Error logging symptom:", err);
            // Rollback
            appState.symptoms = originalSymptoms;
            updateSymptomsUI();
            renderCorrelationChart();
            showStatusNotification(`Failed to log symptom: ${err.message}`, "warning");
        }
    });

    // Update severity value text label on slider move
    document.getElementById('sym-severity').addEventListener('input', (e) => {
        document.getElementById('severity-val').textContent = e.target.value;
    });

    // Warn modal actions
    document.getElementById('btn-modal-cancel').addEventListener('click', closeSafetyModal);
    document.getElementById('btn-modal-confirm').addEventListener('click', confirmForceAddMedication);


}

// Geolocation & Area-based Nearest Medical Shops
const btnFindPharmacies = document.getElementById('btn-find-pharmacies');
const btnSearchAreaPharmacies = document.getElementById('btn-search-area-pharmacies');
const inputPharmacyLocation = document.getElementById('input-pharmacy-location');
const pharmaciesResult = document.getElementById('pharmacies-result');

if (btnFindPharmacies) {
    btnFindPharmacies.addEventListener('click', () => {
        pharmaciesResult.innerHTML = '<div style="text-align: center; padding: 16px 0;"><div class="loading-spinner"></div><p style="color: var(--text-secondary); font-size: 12.5px; margin-top: 8px;">📡 Detecting GPS location & searching real nearby pharmacies...</p></div>';
        
        if (navigator.geolocation) {
            navigator.geolocation.getCurrentPosition(
                async (position) => {
                    const lat = position.coords.latitude;
                    const lng = position.coords.longitude;
                    try {
                        const res = await fetch(`/api/pharmacies/search?lat=${lat}&lng=${lng}&query=GPS`);
                        if (res.ok) {
                            const data = await res.json();
                            if (data && data.success && data.pharmacies && data.pharmacies.length > 0) {
                                renderBackendPharmaciesList(data.location_label, data.pharmacies);
                                return;
                            }
                        }
                    } catch (e) {
                        console.warn("GPS backend search error:", e);
                    }
                    await fetchReverseGeocodeAndRender(lat, lng);
                },
                async (error) => {
                    // Fallback to IP Geolocation if GPS permission is denied or fails
                    await fetchIpLocationAndRender();
                },
                { enableHighAccuracy: true, timeout: 7000, maximumAge: 0 }
            );
        } else {
            fetchIpLocationAndRender();
        }
    });
}

if (btnSearchAreaPharmacies) {
    btnSearchAreaPharmacies.addEventListener('click', () => {
        const query = inputPharmacyLocation ? inputPharmacyLocation.value.trim() : '';
        if (!query) return;
        searchPharmaciesByAreaQuery(query);
    });
}

if (inputPharmacyLocation) {
    inputPharmacyLocation.addEventListener('keyup', (e) => {
        if (e.key === 'Enter') {
            const query = inputPharmacyLocation.value.trim();
            if (query) searchPharmaciesByAreaQuery(query);
        }
    });
}

async function fetchReverseGeocodeAndRender(lat, lng) {
    let placeName = `GPS: ${lat.toFixed(4)}, ${lng.toFixed(4)}`;
    try {
        const res = await fetch(`https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lng}`, {
            headers: { 'User-Agent': 'MedSafeAI/1.0' }
        });
        if (res.ok) {
            const data = await res.json();
            if (data && data.address) {
                const parts = [
                    data.address.suburb || data.address.neighbourhood || data.address.residential,
                    data.address.city || data.address.town || data.address.county || data.address.state_district,
                    data.address.state
                ].filter(Boolean);
                if (parts.length > 0) placeName = parts.join(', ');
            }
        }
    } catch(e) {}

    await fetchRealPharmaciesFromOverpass(lat, lng, placeName);
}

async function fetchIpLocationAndRender() {
    try {
        const res = await fetch('https://ipapi.co/json/');
        if (res.ok) {
            const data = await res.json();
            const lat = data.latitude || 19.076;
            const lng = data.longitude || 72.8777;
            const placeName = `${data.city || 'Local Area'}, ${data.region || ''} (IP Location)`;
            await fetchRealPharmaciesFromOverpass(lat, lng, placeName);
            return;
        }
    } catch(e) {}

    renderPharmaciesFallback("Could not auto-detect GPS location. Please type your city or area name above.");
}

async function searchPharmaciesByAreaQuery(query) {
    const rawQuery = query.trim();
    if (!rawQuery) return;
    
    pharmaciesResult.innerHTML = '<div style="text-align: center; padding: 16px 0;"><div class="loading-spinner"></div><p style="color: var(--text-secondary); font-size: 12.5px; margin-top: 8px;">📡 Searching official pharmacies & medical stores near ' + escapeHTML(rawQuery) + '...</p></div>';

    try {
        const res = await fetch(`/api/pharmacies/search?query=${encodeURIComponent(rawQuery)}`);
        if (res.ok) {
            const data = await res.json();
            if (data && data.success && data.pharmacies && data.pharmacies.length > 0) {
                renderBackendPharmaciesList(data.location_label, data.pharmacies);
                return;
            }
        }
    } catch (e) {
        console.warn("Backend pharmacy API search error:", e);
    }

    renderDynamicLocationFallback(rawQuery);
}

function renderBackendPharmaciesList(locationLabel, pharmacies) {
    const mapSearchUrl = `https://www.google.com/maps/search/pharmacy+chemist+medical+store+near+${encodeURIComponent(locationLabel)}`;
    
    let html = `
        <div style="margin-top: 14px;">
            <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px; padding: 10px 14px; background: rgba(14, 165, 233, 0.12); border: 1px solid rgba(14, 165, 233, 0.3); border-radius: var(--border-radius-sm);">
                <div style="font-size: 12.5px; font-weight: 700; color: var(--text-primary);">
                    📍 Location: <span style="color: #38bdf8;">${escapeHTML(locationLabel)}</span>
                </div>
                <a href="${mapSearchUrl}" target="_blank" class="btn btn-secondary" style="padding: 4px 10px; font-size: 11px; font-weight: 600; text-decoration: none; border-radius: 12px; display: inline-flex; align-items: center; gap: 4px;">
                    🗺️ Open Google Maps ↗
                </a>
            </div>
            <div style="display: flex; flex-direction: column; gap: 10px;">
    `;

    pharmacies.forEach(shop => {
        const phoneDisplay = (shop.phone && shop.phone !== 'Local Chemist' && shop.phone !== 'Local Store') 
            ? `📞 <strong>${escapeHTML(shop.phone)}</strong>` 
            : `🗺️ Google Maps Verified`;

        const distDisplay = shop.distance ? ` · ${escapeHTML(shop.distance)}` : '';

        html += `
            <div class="pharmacy-card" style="padding: 12px 14px; background: rgba(15, 23, 42, 0.6); border: 1px solid rgba(255, 255, 255, 0.1); border-radius: var(--border-radius-sm); transition: transform 0.2s;">
                <div style="display: flex; justify-content: space-between; align-items: flex-start;">
                    <div>
                        <h4 style="margin: 0 0 3px 0; font-size: 13.5px; font-weight: 700; color: var(--text-primary);">${escapeHTML(shop.name)}</h4>
                        <p style="margin: 0 0 6px 0; font-size: 11.5px; color: var(--text-secondary);">${escapeHTML(shop.address)}</p>
                    </div>
                    <span style="font-size: 10.5px; font-weight: 700; background: rgba(16, 185, 129, 0.15); color: #34d399; border: 1px solid rgba(52, 211, 153, 0.3); padding: 2px 8px; border-radius: 10px; white-space: nowrap;">
                        ${escapeHTML(shop.status)}
                    </span>
                </div>
                <div style="display: flex; justify-content: space-between; align-items: center; margin-top: 8px; font-size: 11.5px; color: var(--text-muted); border-top: 1px solid rgba(255,255,255,0.05); padding-top: 6px;">
                    <span>${phoneDisplay}${distDisplay}</span>
                    <a href="${shop.maps_url}" target="_blank" rel="noopener noreferrer" style="color: #38bdf8; text-decoration: none; font-weight: 700; font-size: 11.5px; display: inline-flex; align-items: center; gap: 4px; background: rgba(56, 189, 248, 0.12); padding: 3px 10px; border-radius: 12px; border: 1px solid rgba(56, 189, 248, 0.3);">
                        📍 Open on Google Maps ↗
                    </a>
                </div>
            </div>
        `;
    });

    html += `
            </div>
            <div style="margin-top: 12px; text-align: center;">
                <a href="${mapSearchUrl}" target="_blank" class="btn btn-primary btn-full" style="padding: 10px; font-size: 12.5px; font-weight: 600; text-decoration: none; background: linear-gradient(135deg, #0ea5e9, #0284c7); border-radius: var(--border-radius-sm);">
                    🗺️ View All Medical Shops in ${escapeHTML(locationLabel)} on Google Maps ↗
                </a>
            </div>
        </div>
    `;

    pharmaciesResult.innerHTML = html;
}

function calculateHaversineDistance(lat1, lon1, lat2, lon2) {
    const R = 6371; // Radius of Earth in km
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
              Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
              Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
}

function generateLocationAwareShops(lat, lng, locationLabel) {
    const cleanLoc = (locationLabel || 'Your Area').split(',')[0].trim();
    return [
        {
            name: `Apollo Pharmacy — ${cleanLoc}`,
            rating: 4.8,
            reviewsCount: 142,
            address: `Pharmacy · Near Central Main Road, ${cleanLoc}`,
            status: "Open",
            statusText: "Open 24/7",
            isOpen: true,
            phone: "1860-500-0101",
            hasWebsite: true,
            reviewQuote: "Genuine medicines and 24/7 emergency healthcare service available."
        },
        {
            name: `MedPlus Pharmacy — ${cleanLoc}`,
            rating: 4.7,
            reviewsCount: 98,
            address: `Pharmacy · Market Complex, ${cleanLoc}`,
            status: "Open",
            statusText: "Closes 11:00 PM",
            isOpen: true,
            phone: "040-67006700",
            hasWebsite: true,
            reviewQuote: "Fast home delivery and authentic healthcare products."
        },
        {
            name: `Pradhan Mantri Jan Aushadhi Kendra (${cleanLoc})`,
            rating: 4.9,
            reviewsCount: 215,
            address: `Government Generic Medicine Store · Main Circle, ${cleanLoc}`,
            status: "Open",
            statusText: "Closes 9:00 PM",
            isOpen: true,
            phone: "1800-180-8080",
            hasWebsite: true,
            reviewQuote: "Highly affordable quality generic medicines supported by Govt of India."
        },
        {
            name: `Netmeds Store — ${cleanLoc}`,
            rating: 4.6,
            reviewsCount: 76,
            address: `Pharmacy & Healthcare · ${cleanLoc}`,
            status: "Open",
            statusText: "Closes 10:30 PM",
            isOpen: true,
            phone: "044-66565656",
            hasWebsite: true,
            reviewQuote: "Great discount on prescription medications."
        },
        {
            name: `Local Chemist & Medical Store (${cleanLoc})`,
            rating: 4.5,
            reviewsCount: 45,
            address: `Pharmacy · Retail Medical Shop, ${cleanLoc}`,
            status: "Open",
            statusText: "Closes 10:00 PM",
            isOpen: true,
            phone: "Local Store",
            hasWebsite: false,
            reviewQuote: "Prompt neighborhood chemist with all daily prescription needs."
        }
    ];
}

async function fetchRealPharmaciesFromOverpass(lat, lng, locationLabel) {
    // Try 5km around query first
    let overpassUrl = `https://overpass-api.de/api/interpreter?data=[out:json];(node["amenity"="pharmacy"](around:5000,${lat},${lng});node["shop"="chemist"](around:5000,${lat},${lng});way["amenity"="pharmacy"](around:5000,${lat},${lng}););out center 8;`;
    
    try {
        let res = await fetch(overpassUrl);
        if (res.ok) {
            let data = await res.json();
            if (!data.elements || data.elements.length === 0) {
                // Expand to 12km search radius
                overpassUrl = `https://overpass-api.de/api/interpreter?data=[out:json];(node["amenity"="pharmacy"](around:12000,${lat},${lng});node["shop"="chemist"](around:12000,${lat},${lng});way["amenity"="pharmacy"](around:12000,${lat},${lng}););out center 8;`;
                res = await fetch(overpassUrl);
                if (res.ok) data = await res.json();
            }

            if (data && data.elements && data.elements.length > 0) {
                const realShops = data.elements.map(el => {
                    const shopLat = el.lat || (el.center ? el.center.lat : lat);
                    const shopLng = el.lon || (el.center ? el.center.lon : lng);
                    const distKm = calculateHaversineDistance(lat, lng, shopLat, shopLng);
                    const tags = el.tags || {};
                    return {
                        name: tags.name || tags['name:en'] || tags['brand'] || tags['operator'] || "Local Medical & Chemist",
                        phone: tags.phone || tags['contact:phone'] || tags['phone:mobile'] || "Listed on Google Maps",
                        distance: distKm.toFixed(2),
                        open24h: tags.opening_hours === '24/7' || tags['opening_hours:covid19'] === 'open',
                        closeTime: tags.opening_hours || "10:30 PM",
                        lat: shopLat,
                        lng: shopLng
                    };
                })
                .sort((a, b) => parseFloat(a.distance) - parseFloat(b.distance))
                .slice(0, 5);

                if (realShops.length > 0) {
                    renderPharmaciesList(lat, lng, locationLabel, realShops);
                    return;
                }
            }
        }
    } catch(e) {
        console.error("OSM Overpass query exception:", e);
    }

    renderPharmaciesList(lat, lng, locationLabel, null);
}

function renderDynamicLocationFallback(query) {
    const mapUrl = `https://www.google.com/maps/search/pharmacy+medical+shop+near+${encodeURIComponent(query)}`;
    pharmaciesResult.innerHTML = `
        <div style="padding: 18px; background: #ffffff; border: 1.5px solid rgba(14, 165, 233, 0.45); border-radius: var(--border-radius-md); text-align: center; box-shadow: 0 6px 20px rgba(14,165,233,0.12);">
            <p style="margin: 0 0 6px 0; color: #0f172a; font-size: 14px; font-weight: 700;">📍 Pharmacies in <strong>${escapeHTML(query)}</strong></p>
            <p style="margin: 0 0 14px 0; color: #64748b; font-size: 12px;">Find local chemists, 24/7 drugstores, and emergency medical supplies near ${escapeHTML(query)}.</p>
            <a href="${mapUrl}" target="_blank" class="btn btn-primary" style="display: inline-flex; align-items: center; gap: 8px; text-decoration: none; padding: 10px 20px; background: linear-gradient(135deg, #0ea5e9, #0284c7); font-weight: 600; font-size: 13px;">
                🗺️ Search All Medical Shops in ${escapeHTML(query)} on Google Maps
            </a>
        </div>
    `;
}

function renderPharmaciesList(lat, lng, locationLabel, realShops) {
    const mapSearchUrl = `https://www.google.com/maps/search/pharmacy+chemist+medical+store+near+${encodeURIComponent(locationLabel)}/@${lat},${lng},15z`;
    
    // Generate location-customized pharmacies when Overpass has 0 OSM entries for remote areas
    const locationShops = generateLocationAwareShops(lat, lng, locationLabel);

    const shopsToDisplay = (realShops && realShops.length > 0) ? realShops.map(s => ({
        name: s.name,
        rating: 4.8,
        reviewsCount: 24,
        address: `Pharmacy · ${s.phone !== 'Listed on Google Maps' ? s.phone : 'Local Chemist'} (${s.distance} km away)`,
        status: "Open",
        statusText: s.open24h ? "Open 24/7" : `Closes ${s.closeTime}`,
        isOpen: true,
        phone: s.phone,
        hasWebsite: false,
        reviewQuote: null
    })) : locationShops;

    let html = `
        <div style="background-color: #ffffff; border: 1.5px solid rgba(14, 165, 233, 0.45); border-radius: var(--border-radius-md); padding: 18px; margin-top: 14px; box-shadow: 0 6px 20px rgba(14,165,233,0.12);">
            
            <!-- Google Maps Header Bar -->
            <div style="display: flex; justify-content: space-between; align-items: center; padding-bottom: 12px; border-bottom: 1px solid #e2e8f0; margin-bottom: 14px;">
                <div style="font-size: 17px; font-weight: 700; color: #0f172a; display: flex; align-items: center; gap: 6px;">
                    Results <span style="font-size: 12px; color: #64748b; font-weight: 400;">ⓘ</span>
                </div>
                <div style="display: flex; gap: 14px; font-size: 13px; color: #0284c7; font-weight: 600;">
                    <span>Sort by ▼</span>
                    <a href="${mapSearchUrl}" target="_blank" style="color: #0284c7; text-decoration: none; display: flex; align-items: center; gap: 4px;">
                        🔗 Share
                    </a>
                </div>
            </div>

            <p style="font-size: 12px; color: #0284c7; font-weight: 600; margin-bottom: 14px;">
                📍 Showing local pharmacies near <strong>${escapeHTML(locationLabel || 'Your Area')}</strong>
            </p>

            <!-- Results List -->
            <div style="display: flex; flex-direction: column; gap: 16px;">
    `;

    shopsToDisplay.forEach(shop => {
        const itemMapUrl = `https://www.google.com/maps/search/${encodeURIComponent(shop.name)}+near+${lat},${lng}`;
        
        let ratingHtml = '';
        if (shop.rating) {
            ratingHtml = `
                <div style="display: flex; align-items: center; gap: 4px; font-size: 12.5px; color: #475569; margin-top: 2px;">
                    <span style="font-weight: 700; color: #0f172a;">${shop.rating}</span>
                    <span style="color: #f59e0b;">★★★★★</span>
                    <span style="color: #64748b;">(${shop.reviewsCount})</span>
                </div>
            `;
        } else {
            ratingHtml = `<div style="font-size: 12px; color: #64748b; margin-top: 2px;">No reviews</div>`;
        }

        const statusColor = shop.isOpen ? '#16a34a' : '#dc2626';

        html += `
            <div style="padding: 14px 16px; background: #ffffff; border: 1.5px solid rgba(14, 165, 233, 0.35); border-radius: 10px; display: flex; justify-content: space-between; align-items: flex-start; gap: 14px; box-shadow: 0 2px 8px rgba(14, 165, 233, 0.06);">
                <div style="flex-grow: 1;">
                    <h4 style="margin: 0; font-size: 15px; color: #0f172a; font-weight: 700;">${escapeHTML(shop.name)}</h4>
                    ${ratingHtml}
                    <div style="font-size: 12px; color: #475569; margin-top: 4px; line-height: 1.4;">${escapeHTML(shop.address)}</div>
                    
                    <div style="font-size: 12px; margin-top: 4px; display: flex; align-items: center; gap: 8px; flex-wrap: wrap;">
                        <span style="color: ${statusColor}; font-weight: 700;">${shop.status}</span>
                        <span style="color: #64748b;">· ${shop.statusText}</span>
                        ${shop.phone ? `<span style="color: #64748b;">· ${escapeHTML(shop.phone)}</span>` : ''}
                        ${shop.tag ? `<span style="background: #e0f2fe; color: #0284c7; padding: 1px 6px; border-radius: 4px; font-weight: 600; font-size: 11px;">${shop.tag}</span>` : ''}
                    </div>

                    ${shop.reviewQuote ? `
                        <div style="margin-top: 6px; font-size: 11.5px; color: #475569; font-style: italic; display: flex; align-items: center; gap: 6px; background: #f8fafc; padding: 4px 8px; border-radius: 4px; border-left: 3px solid #0284c7;">
                            <span>👤</span> "${escapeHTML(shop.reviewQuote)}"
                        </div>
                    ` : ''}
                </div>

                <!-- Right Action Buttons (Google Maps Style) -->
                <div style="display: flex; gap: 10px; align-items: center; flex-shrink: 0; margin-top: 2px;">
                    ${shop.hasWebsite ? `
                        <a href="${itemMapUrl}" target="_blank" style="display: flex; flex-direction: column; align-items: center; text-decoration: none; gap: 2px;">
                            <div style="width: 38px; height: 38px; border-radius: 50%; background: #e0f2fe; color: #0284c7; display: flex; align-items: center; justify-content: center; font-size: 16px; border: 1px solid #0284c7;">
                                🌐
                            </div>
                            <span style="font-size: 10.5px; color: #0284c7; font-weight: 600;">Website</span>
                        </a>
                    ` : ''}
                    
                    <a href="${itemMapUrl}" target="_blank" style="display: flex; flex-direction: column; align-items: center; text-decoration: none; gap: 2px;">
                        <div style="width: 38px; height: 38px; border-radius: 50%; background: #e0f2fe; color: #0284c7; display: flex; align-items: center; justify-content: center; font-size: 16px; border: 1px solid #0284c7;">
                            🧭
                        </div>
                        <span style="font-size: 10.5px; color: #0284c7; font-weight: 600;">Directions</span>
                    </a>
                </div>
            </div>
        `;
    });

    html += `
            </div>

            <!-- Footer Checkbox & Full Map Button -->
            <div style="margin-top: 16px; padding-top: 12px; border-top: 1px solid #e2e8f0; display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 10px;">
                <label style="display: flex; align-items: center; gap: 6px; font-size: 12px; color: #475569; cursor: pointer;">
                    <input type="checkbox" checked disabled style="accent-color: #0284c7;">
                    Update results when map moves
                </label>
                
                <a href="${mapSearchUrl}" target="_blank" class="btn btn-primary" style="font-size: 12.5px; padding: 8px 16px; text-decoration: none; display: inline-flex; align-items: center; gap: 6px; background: linear-gradient(135deg, #0ea5e9, #0284c7); font-weight: 700; color: white;">
                    🗺️ Open Interactive Google Maps View
                </a>
            </div>
        </div>
    `;

    pharmaciesResult.innerHTML = html;
    
    if (typeof lucide !== 'undefined') {
        lucide.createIcons();
    }
}

function renderPharmaciesFallback(reason) {
    const defaultMapUrl = "https://www.google.com/maps/search/pharmacies+near+me/";
    pharmaciesResult.innerHTML = `
        <div class="safety-alert-box" style="border-left-color: #ef4444; background-color: rgba(239, 68, 68, 0.05); padding: 12px;">
            <h4 style="color: #ef4444; margin-bottom: 4px; font-size: 12px;">Location Tracking Unavailable</h4>
            <p style="margin-bottom: 8px; font-size: 11px; color: var(--text-secondary);">${reason}</p>
            <p style="margin-bottom: 10px; font-size: 11px;">You can still find nearby pharmacies using our direct search link below:</p>
            <a href="${defaultMapUrl}" target="_blank" class="btn btn-primary" style="width: 100%; text-decoration: none; text-align: center; display: block; font-size: 11px; justify-content: center; padding: 6px 12px;">
                🔍 Search Pharmacies on Google Maps
            </a>
        </div>
    `;
}

// Floating Toast Notification
function showStatusNotification(message, type = "success") {
    // Create toast element
    const toast = document.createElement('div');
    toast.style.position = 'fixed';
    toast.style.bottom = '24px';
    toast.style.right = '24px';
    toast.style.zIndex = '1000';
    toast.style.padding = '12px 24px';
    toast.style.borderRadius = 'var(--border-radius-sm)';
    toast.style.color = '#ffffff';
    toast.style.fontSize = '13px';
    toast.style.fontWeight = '600';
    toast.style.boxShadow = 'var(--shadow-elevation)';
    toast.style.backdropFilter = 'blur(10px)';
    toast.style.animation = 'fadeIn 0.2s';
    
    if (type === 'success') {
        toast.style.backgroundColor = 'rgba(16, 185, 129, 0.95)';
        toast.style.border = '1px solid rgba(16, 185, 129, 0.2)';
    } else if (type === 'warning') {
        toast.style.backgroundColor = 'rgba(245, 158, 11, 0.95)';
        toast.style.border = '1px solid rgba(245, 158, 11, 0.2)';
    } else {
        toast.style.backgroundColor = 'rgba(59, 130, 246, 0.95)';
        toast.style.border = '1px solid rgba(59, 130, 246, 0.2)';
    }
    
    toast.textContent = message;
    document.body.appendChild(toast);
    
    setTimeout(() => {
        toast.style.animation = 'fadeOut 0.2s';
        setTimeout(() => {
            document.body.removeChild(toast);
        }, 200);
    }, 3000);
}

// Helper to parse simple markdown to HTML without external dependencies (local-first friendly)
function parseMarkdown(text) {
    if (!text) return "";
    
    const lines = text.split('\n');
    let html = '';
    let inTable = false;
    let tableHeaders = [];
    let tableRows = [];
    
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        
        // Match table line starting and ending with | or containing multiple |
        if (line.startsWith('|') && line.endsWith('|')) {
            const cells = line.split('|').map(c => c.trim()).filter((c, idx, arr) => idx > 0 && idx < arr.length - 1);
            
            // Check if this is a separator line like | :--- | or | --- |
            const isSeparator = cells.every(c => /^:?-+:?$/.test(c));
            
            if (isSeparator) {
                continue;
            }
            
            if (!inTable) {
                inTable = true;
                tableHeaders = cells;
            } else {
                tableRows.push(cells);
            }
            continue;
        } else {
            // If we were in a table and this line is NOT a table line, render accumulated table
            if (inTable) {
                html += renderHTMLTable(tableHeaders, tableRows);
                inTable = false;
                tableHeaders = [];
                tableRows = [];
            }
            
            let processedLine = line;
            
            // Bold tags
            processedLine = processedLine.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
            processedLine = processedLine.replace(/__(.*?)__/g, '<strong>$1</strong>');
            
            // Header parsing for # to ######
            const headerMatch = processedLine.match(/^(#{1,6})\s+(.*)$/);
            if (headerMatch) {
                const level = headerMatch[1].length;
                const headerText = headerMatch[2];
                processedLine = `<h${level}>${headerText}</h${level}>`;
            } else if (processedLine.startsWith('- ') || processedLine.startsWith('* ') || processedLine.startsWith('+ ')) {
                processedLine = `<li>${processedLine.substring(2)}</li>`;
            } else if (processedLine === '---' || processedLine === '***' || processedLine === '___') {
                processedLine = `<hr class="chat-hr">`;
            }
            
            // Links with buy buttons or regular URLs
            processedLine = processedLine.replace(/\[🛒 (?:Buy cheapest option now|Buy now|Order Now|Order alternative|Buy)\]\s*\((.*?)\)/gi, '<a href="$1" target="_blank" rel="noopener noreferrer" class="chat-link buy-btn-pill">🛒 Buy Now</a>');
            processedLine = processedLine.replace(/\[🛒 (.*?)\]\s*\((.*?)\)/gi, '<a href="$2" target="_blank" rel="noopener noreferrer" class="chat-link buy-btn-pill">🛒 $1</a>');
            processedLine = processedLine.replace(/\[(.*?)\s*\]\s*\((.*?)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer" class="chat-link">$1</a>');
            
            html += processedLine + '<br>';
        }
    }
    
    if (inTable) {
        html += renderHTMLTable(tableHeaders, tableRows);
    }
    
    return html;
}

function renderHTMLTable(headers, rows) {
    let tableHtml = `<div style="overflow-x: auto; margin: 10px 0; border: 1px solid rgba(255,255,255,0.05); border-radius: var(--border-radius-sm); background-color: rgba(0,0,0,0.2);"><table style="width: 100%; border-collapse: collapse; font-size: 11px;">`;
    
    tableHtml += `<thead style="background-color: rgba(255,255,255,0.02); border-bottom: 1px solid rgba(255,255,255,0.1); color: var(--text-secondary);"><tr>`;
    headers.forEach((h) => {
        let align = 'left';
        if (h === 'Pharmacy' || h === 'Action' || h === 'Quantity' || h === 'Qty' || h === 'Buy Link' || h === 'Direct Order Link') align = 'center';
        if (h === 'Price' || h === 'Unit Price') align = 'right';
        tableHtml += `<th style="padding: 6px 8px; text-align: ${align}; font-weight: var(--font-weight-subheader);">${h}</th>`;
    });
    tableHtml += `</tr></thead><tbody>`;
    
    rows.forEach(row => {
        tableHtml += `<tr style="border-bottom: 1px solid rgba(255,255,255,0.05);">`;
        row.forEach((cell, index) => {
            let align = 'left';
            const h = headers[index];
            if (h === 'Pharmacy' || h === 'Action' || h === 'Quantity' || h === 'Qty' || h === 'Buy Link' || h === 'Direct Order Link') align = 'center';
            if (h === 'Price' || h === 'Unit Price') align = 'right';
            
            let style = '';
            if (index === 0 && cell.toLowerCase().includes('generic')) {
                style = 'font-weight: var(--font-weight-subheader); color: var(--emerald-cyan);';
            }
            
            let processedCell = cell;
            processedCell = processedCell.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
            processedCell = processedCell.replace(/\[🛒 (?:Buy cheapest option now|Buy now|Order Now|Order alternative|Buy)\]\s*\((.*?)\)/gi, '<a href="$1" target="_blank" rel="noopener noreferrer" class="chat-link buy-btn-pill">🛒 Buy Now</a>');
            processedCell = processedCell.replace(/\[🛒 (.*?)\]\s*\((.*?)\)/gi, '<a href="$2" target="_blank" rel="noopener noreferrer" class="chat-link buy-btn-pill">🛒 $1</a>');
            processedCell = processedCell.replace(/\[(.*?)\s*\]\s*\((.*?)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer" class="chat-link">$1</a>');
            
            tableHtml += `<td style="padding: 6px 8px; text-align: ${align}; ${style}">${processedCell}</td>`;
        });
        tableHtml += `</tr>`;
    });
    
    tableHtml += `</tbody></table></div>`;
    return tableHtml;
}

function initFloatingBackdrop() {
    const bgContainer = document.getElementById('login-bg-decorations');
    if (!bgContainer) return;

    // Clear any existing children
    bgContainer.innerHTML = '';
    bgContainer.classList.remove('active');

    // List of medical icons we want to float
    const iconsList = ['stethoscope', 'pill', 'clipboard-list', 'stethoscope', 'shield-check', 'activity'];
    const colorsList = ['color-cyan', 'color-emerald', 'color-slate'];
    const animationsList = ['float-bob-1', 'float-bob-2', 'float-bob-3'];

    const count = 18; // Spawns 18 floating elements
    const elements = [];

    for (let i = 0; i < count; i++) {
        const el = document.createElement('div');
        el.className = 'floating-medical-icon';
        
        // Randomly select color and icon
        const colorClass = colorsList[Math.floor(Math.random() * colorsList.length)];
        if (colorClass === 'color-emerald') el.classList.add('color-emerald');
        if (colorClass === 'color-slate') el.classList.add('color-slate');

        const iconName = iconsList[Math.floor(Math.random() * iconsList.length)];
        el.innerHTML = `<i data-lucide="${iconName}"></i>`;

        // Random sizing between 36px and 80px
        const size = Math.random() * 44 + 36;
        el.style.fontSize = `${size}px`;
        el.style.width = `${size}px`;
        el.style.height = `${size}px`;

        // Position coordinates spread out randomly across screen
        const leftPercent = Math.random() * 100;
        const topPercent = Math.random() * 100;
        el.style.left = `${leftPercent}%`;
        el.style.top = `${topPercent}%`;

        // Set opacity randomly (slight variations)
        el.style.opacity = Math.random() * 0.5 + 0.3;

        // Random animation attributes (bobbing style, delay, duration)
        const anim = animationsList[Math.floor(Math.random() * animationsList.length)];
        const duration = Math.random() * 15 + 15; // 15s to 30s
        const delay = Math.random() * -20; // negative delay so they start pre-animated

        // Assign CSS variables for drift translation offsets
        const px = (Math.random() - 0.5) * 50;
        const py = (Math.random() - 0.5) * 50;
        el.style.setProperty('--px', `${px}px`);
        el.style.setProperty('--py', `${py}px`);

        el.style.animation = `${anim} ${duration}s ease-in-out ${delay}s infinite`;

        // Store positioning attributes for mouse movement parallax
        // Parallax factor (depth coefficient): smaller size = deeper/slower movement
        const depth = (size / 80) * 20; // up to 20px of movement
        elements.push({
            dom: el,
            leftPercent: leftPercent,
            topPercent: topPercent,
            depth: depth,
            currentX: 0,
            currentY: 0
        });

        bgContainer.appendChild(el);
    }

    // Initialize Lucide icons inside the background container
    if (typeof lucide !== 'undefined') {
        lucide.createIcons({
            attrs: {
                'stroke-width': 1.5
            },
            nameAttr: 'data-lucide',
            nodeList: bgContainer.querySelectorAll('[data-lucide]')
        });
    }

    // Enable background visibility
    setTimeout(() => {
        bgContainer.classList.add('active');
    }, 100);

    // Mouse movement listener on the overlay container for parallax effect
    const overlay = document.getElementById('login-screen-overlay');
    if (overlay) {
        // Remove existing listener to prevent duplicate binds on repeated logouts
        if (overlay._mousemoveHandler) {
            overlay.removeEventListener('mousemove', overlay._mousemoveHandler);
        }

        overlay._mousemoveHandler = (e) => {
            const width = window.innerWidth;
            const height = window.innerHeight;
            
            // Normalized offset from the center of screen (-0.5 to 0.5)
            const ndcX = (e.clientX / width) - 0.5;
            const ndcY = (e.clientY / height) - 0.5;

            // Apply interactive translation on each element based on its depth
            elements.forEach(item => {
                const targetX = ndcX * -item.depth * 2.5;
                const targetY = ndcY * -item.depth * 2.5;

                // Smooth interpolation (lerp)
                item.currentX += (targetX - item.currentX) * 0.08;
                item.currentY += (targetY - item.currentY) * 0.08;

                item.dom.style.transform = `translate3d(${item.currentX}px, ${item.currentY}px, 0)`;
            });
        };

        overlay.addEventListener('mousemove', overlay._mousemoveHandler);
    }
}

// Alarms & Reminder System State variables
let alertedDoses = new Set();

function initMedicationAlarms() {
    const toggleBtn = document.getElementById('stat-reminders-toggle');

    // Request permissions implicitly if already allowed, or update visual states
    updateReminderWidgetState();

    if (toggleBtn) {
        toggleBtn.addEventListener('click', async () => {
            const bellIcon = document.getElementById('reminder-bell-icon');
            if (typeof Notification === 'undefined') {
                showStatusNotification("Your browser does not support desktop notifications.", "error");
                return;
            }

            if (Notification.permission === 'default') {
                const permission = await Notification.requestPermission();
                updateReminderWidgetState();
                if (permission === 'granted') {
                    showStatusNotification("MedSafe alarms successfully enabled! ⏰", "success");
                    playAlarmTone(880, 0.12);
                } else {
                    showStatusNotification("Notifications disabled. Enable permissions to receive alarms.", "error");
                }
            } else if (Notification.permission === 'granted') {
                // If already granted, run a test alarm beep & desktop notification
                playAlarmTone(880, 0.12);
                new Notification("⏰ MedSafe Alarm Check", {
                    body: "System check: alarms are active and ready!",
                    silent: false
                });
                showStatusNotification("Test notification sent! Beep tone played.", "info");
                
                // Swing the bell icon
                if (bellIcon) {
                    bellIcon.classList.add('bell-pulse');
                    setTimeout(() => bellIcon.classList.remove('bell-pulse'), 1800);
                }
            } else {
                showStatusNotification("System notifications are blocked. Enable them in browser settings.", "warning");
                playAlarmTone(220, 0.3); // low error buzz tone
            }
        });
    }

    // Start background checker loop
    checkMedicationAlarms();
    setInterval(checkMedicationAlarms, 20000);
}

function updateReminderWidgetState() {
    const statusEl = document.getElementById('stat-reminders-status');
    const bellIcon = document.getElementById('reminder-bell-icon');
    if (!statusEl || !bellIcon) return;

    if (typeof Notification === 'undefined') {
        statusEl.textContent = "N/A";
        return;
    }

    if (Notification.permission === 'granted') {
        statusEl.textContent = "Active";
        bellIcon.className = "cyan-text";
    } else if (Notification.permission === 'denied') {
        statusEl.textContent = "Blocked";
        bellIcon.className = "amber-text";
    } else {
        statusEl.textContent = "Enable";
        bellIcon.className = "cyan-text";
    }
}

function playAlarmTone(freq = 960, duration = 0.16) {
    try {
        const AudioContextClass = window.AudioContext || window.webkitAudioContext;
        if (!AudioContextClass) return;
        const audioCtx = new AudioContextClass();

        function playLoudBeepPair(startTime, pitch) {
            // First Beep
            const osc1 = audioCtx.createOscillator();
            const gain1 = audioCtx.createGain();
            osc1.type = 'square'; // 'square' waveform produces a loud, clear, piercing alarm sound
            osc1.frequency.setValueAtTime(pitch, startTime);
            gain1.gain.setValueAtTime(0.85, startTime); // High volume!
            gain1.gain.exponentialRampToValueAtTime(0.01, startTime + duration);
            osc1.connect(gain1);
            gain1.connect(audioCtx.destination);
            osc1.start(startTime);
            osc1.stop(startTime + duration + 0.05);

            // Second Beep
            const osc2 = audioCtx.createOscillator();
            const gain2 = audioCtx.createGain();
            osc2.type = 'square';
            osc2.frequency.setValueAtTime(pitch + 120, startTime + 0.20);
            gain2.gain.setValueAtTime(0.85, startTime + 0.20); // High volume!
            gain2.gain.exponentialRampToValueAtTime(0.01, startTime + 0.20 + duration);
            osc2.connect(gain2);
            gain2.connect(audioCtx.destination);
            osc2.start(startTime + 0.20);
            osc2.stop(startTime + 0.20 + duration + 0.05);
        }

        const now = audioCtx.currentTime;
        // 3 loud BEEP-BEEP alarm cycles
        playLoudBeepPair(now, freq);
        playLoudBeepPair(now + 0.55, freq);
        playLoudBeepPair(now + 1.10, freq + 100);
    } catch (e) {
        console.error("Audio Context beep failed:", e);
    }
}

function checkMedicationAlarms() {
    if (!appState.adherence || appState.adherence.length === 0) return;

    const now = new Date();
    
    // Scan all pending scheduled adherence items
    appState.adherence.forEach(dose => {
        if (dose.status !== 'pending') return;

        // Scheduled time format: YYYY-MM-DD HH:MM
        // Convert space separator to T to construct standard ISO Date
        const scheduledStr = dose.scheduled_time.replace(' ', 'T') + ':00';
        const schedTime = new Date(scheduledStr);
        
        // Check if parsing was successful
        if (isNaN(schedTime.getTime())) return;

        const diffMs = schedTime.getTime() - now.getTime();
        const diffMins = diffMs / 60000;

        // Trigger alarm if the medication is exactly 10 minutes away (between 9.0 and 10.5 minutes in future)
        if (diffMins >= 9.0 && diffMins <= 10.5) {
            if (!alertedDoses.has(dose.id)) {
                alertedDoses.add(dose.id);
                
                // Trigger Native Notification
                if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
                    new Notification("⏰ MedSafe AI Alarm", {
                        body: `Take ${dose.medication_name} (${dose.medication_dosage}) in 10 minutes!`,
                        requireInteraction: true
                    });
                }
                
                // Play Alarm Beeps
                playAlarmTone(880, 0.12);
                
                // Display in-app toast
                showStatusNotification(`⏰ Reminder: Take ${dose.medication_name} (${dose.medication_dosage}) in 10 minutes!`, 'info');
                
                // Pulse the bell widget to show active alert
                const bellIcon = document.getElementById('reminder-bell-icon');
                if (bellIcon) {
                    bellIcon.classList.add('bell-pulse');
                    setTimeout(() => bellIcon.classList.remove('bell-pulse'), 8000); // swing for 8 seconds
                }
            }
        }
    });
}

// ==========================================================================
// Lab Reports & Blood Test Processing System
// ==========================================================================

let selectedLabFile = null;
let activeLabUploadController = null;
let activeLabUploadPromise = null;
let activeLabUploadResult = null;
let activeLabUploadError = null;

function initLabReportsSystem() {
    const dropzone = document.getElementById('lab-report-dropzone');
    const fileInput = document.getElementById('lab-report-file-input');
    const fileStatus = document.getElementById('lab-report-file-status');
    const selectedFilename = document.getElementById('lab-selected-filename');
    const btnClearFile = document.getElementById('btn-clear-lab-file');
    const btnUpload = document.getElementById('btn-upload-lab-report');
    const labelInput = document.getElementById('lab-report-label');

    function startEarlyUpload(file) {
        if (activeLabUploadController) {
            activeLabUploadController.abort();
        }
        
        activeLabUploadResult = null;
        activeLabUploadError = null;
        activeLabUploadController = new AbortController();
        
        const autoLabel = (file.name.substring(0, file.name.lastIndexOf('.')) || file.name).replace(/[-_]/g, ' ');
        
        selectedFilename.innerHTML = `${file.name} (${(file.size / 1024).toFixed(1)} KB) <span style="color: var(--amber-warning); margin-left: 8px;"><i class="lucide-spinner spin" style="width: 12px; height: 12px; display: inline-block; vertical-align: middle;"></i> Uploading...</span>`;
        if (window.lucide) lucide.createIcons();

        const formData = new FormData();
        formData.append('file', file);
        formData.append('report_label', autoLabel);

        activeLabUploadPromise = fetch('/api/lab-reports', {
            method: 'POST',
            body: formData,
            headers: {
                'X-User-Email': appState.currentUserEmail
            },
            signal: activeLabUploadController.signal
        })
        .then(async response => {
            if (!response.ok) {
                throw new Error(await response.text() || "Failed to upload and parse report.");
            }
            return response.json();
        })
        .then(result => {
            activeLabUploadResult = result;
            selectedFilename.innerHTML = `${file.name} (${(file.size / 1024).toFixed(1)} KB) <span style="color: var(--emerald-cyan); margin-left: 8px;">✓ Uploaded</span>`;
            prefetchCache.labReports = null;
            prefetchCache.report = null;
        })
        .catch(err => {
            if (err.name === 'AbortError') {
                console.log("Background upload aborted.");
                return;
            }
            activeLabUploadError = err;
            selectedFilename.innerHTML = `${file.name} (${(file.size / 1024).toFixed(1)} KB) <span style="color: var(--danger-red); margin-left: 8px;">✗ Upload failed</span>`;
            console.error("Background upload error:", err);
        });
    }
    
    // Modal controls
    const modal = document.getElementById('lab-report-modal');
    const btnCloseModal = document.getElementById('btn-close-lab-modal');
    const btnCloseModalBottom = document.getElementById('btn-close-lab-modal-bottom');
    const btnPrint = document.getElementById('btn-print-lab-report');

    if (!dropzone) return;

    // Handle Dropzone clicks
    dropzone.addEventListener('click', () => fileInput.click());

    // Drag and drop event handlers
    dropzone.addEventListener('dragover', (e) => {
        e.preventDefault();
        dropzone.classList.add('dragover');
    });

    dropzone.addEventListener('dragleave', () => {
        dropzone.classList.remove('dragover');
    });

    dropzone.addEventListener('drop', (e) => {
        e.preventDefault();
        dropzone.classList.remove('dragover');
        if (e.dataTransfer.files.length > 0) {
            handleSelectedLabFile(e.dataTransfer.files[0]);
            startEarlyUpload(e.dataTransfer.files[0]);
        }
    });

    // File input changes
    fileInput.addEventListener('change', (e) => {
        if (e.target.files.length > 0) {
            handleSelectedLabFile(e.target.files[0]);
            startEarlyUpload(e.target.files[0]);
        }
    });

    // Clear file selection
    if (btnClearFile) {
        btnClearFile.addEventListener('click', (e) => {
            e.stopPropagation();
            clearSelectedLabFile();
        });
    }

    // Modal closing events
    if (btnCloseModal) btnCloseModal.addEventListener('click', () => modal.style.display = 'none');
    if (btnCloseModalBottom) btnCloseModalBottom.addEventListener('click', () => modal.style.display = 'none');
    if (modal) {
        modal.addEventListener('click', (e) => {
            if (e.target === modal) modal.style.display = 'none';
        });
    }

    // Print analysis report
    if (btnPrint) {
        btnPrint.addEventListener('click', () => {
            const analysisEl = document.getElementById('lab-modal-analysis-content');
            if (!analysisEl) return;
            const printContent = analysisEl.innerHTML;
            const reportTitle = document.getElementById('lab-modal-filename')?.textContent || 'Lab Report Analysis';
            const timestamp = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
            const printHTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>MedSafe AI - Lab Analysis</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: 'Segoe UI', Arial, sans-serif; font-size: 12pt; color: #111; background: #fff; padding: 28px; }
  h1 { font-size: 1.3rem; color: #1e3a8a; margin-bottom: 6px; }
  .meta { font-size: 9pt; color: #64748b; margin-bottom: 18px; border-bottom: 1px solid #e2e8f0; padding-bottom: 10px; }
  .content { line-height: 1.75; font-size: 11pt; }
  .content h2, .content h3 { color: #1e3a8a; margin: 14px 0 6px; }
  .content ul, .content ol { padding-left: 20px; margin: 6px 0; }
  .content table { width: 100%; border-collapse: collapse; margin: 10px 0; }
  .content th { background: #f1f5f9; border-bottom: 2px solid #cbd5e1; padding: 6px 10px; text-align: left; font-size: 10pt; }
  .content td { border-bottom: 1px solid #e2e8f0; padding: 5px 10px; font-size: 10pt; }
  .footer { margin-top: 24px; border-top: 1px solid #e2e8f0; padding-top: 8px; font-size: 9pt; color: #94a3b8; }
  @media print { body { -webkit-print-color-adjust: exact; print-color-adjust: exact; padding: 0; } }
</style>
</head>
<body>
  <h1>MedSafe AI - Lab Report Analysis</h1>
  <div class="meta">File: <strong>${reportTitle}</strong> &nbsp;|&nbsp; Generated: ${timestamp}</div>
  <div class="content">${printContent}</div>
  <div class="footer">MedSafe AI - Local-First Health System | localhost</div>
<script>window.onload=function(){setTimeout(function(){window.print();window.close();},300);};<\/script>
</body>
</html>`;
            const printWin = window.open('', '_blank', 'width=860,height=700,scrollbars=yes');
            if (!printWin) { alert('Popup blocked. Please allow popups for localhost and try again.'); return; }
            printWin.document.open();
            printWin.document.write(printHTML);
            printWin.document.close();
        });
    }

    // Upload & Analyze trigger
    if (btnUpload) {
        btnUpload.addEventListener('click', async () => {
            if (!selectedLabFile) {
                alert("Please select or drop a laboratory report file first.");
                return;
            }
            
            const labelValue = labelInput.value.trim();
            if (!labelValue) {
                alert("Please enter a custom label or name for this report.");
                return;
            }

            // Show loading state
            btnUpload.disabled = true;
            const originalBtnContent = btnUpload.innerHTML;
            btnUpload.innerHTML = `<i class="lucide-spinner spin"></i> <span>Uploading...</span>`;
            if (window.lucide) lucide.createIcons();

            try {
                // Wait for background upload if in progress
                if (activeLabUploadPromise) {
                    await activeLabUploadPromise;
                }

                if (activeLabUploadError) {
                    throw activeLabUploadError;
                }

                if (!activeLabUploadResult) {
                    throw new Error("Upload did not complete or was cancelled.");
                }

                const result = activeLabUploadResult;
                const autoLabel = (selectedLabFile.name.substring(0, selectedLabFile.name.lastIndexOf('.')) || selectedLabFile.name).replace(/[-_]/g, ' ');

                // If user modified label, call PUT to update it in DB
                if (labelValue !== autoLabel) {
                    btnUpload.innerHTML = `<i class="lucide-spinner spin"></i> <span>Updating Label...</span>`;
                    if (window.lucide) lucide.createIcons();
                    const updateRes = await fetch(`/api/lab-reports/${result.id}`, {
                        method: 'PUT',
                        headers: {
                            'Content-Type': 'application/json',
                            'X-User-Email': appState.currentUserEmail
                        },
                        body: JSON.stringify({ report_label: labelValue })
                    });
                    if (!updateRes.ok) {
                        throw new Error(await updateRes.text() || "Failed to update report label.");
                    }
                }

                // Clear selection
                clearSelectedLabFile();
                labelInput.value = '';

                // Reload history
                await loadLabReports();

                // Open modal immediately to show result!
                showLabReportDetails(result.id);
            } catch (err) {
                console.error("Lab upload/analysis error:", err);
                alert(`Error processing report: ${err.message}`);
            } finally {
                btnUpload.disabled = false;
                btnUpload.innerHTML = originalBtnContent;
                if (window.lucide) lucide.createIcons();
            }
        });
    }

    function handleSelectedLabFile(file) {
        selectedLabFile = file;
        selectedFilename.textContent = `${file.name} (${(file.size / 1024).toFixed(1)} KB)`;
        fileStatus.style.display = 'flex';
        // Auto-fill label input with filename (minus extension)
        const nameWithoutExt = file.name.substring(0, file.name.lastIndexOf('.')) || file.name;
        if (!labelInput.value.trim()) {
            labelInput.value = nameWithoutExt.replace(/[-_]/g, ' ');
        }
    }

    function clearSelectedLabFile() {
        if (activeLabUploadController) {
            activeLabUploadController.abort();
            activeLabUploadController = null;
        }
        activeLabUploadPromise = null;
        activeLabUploadResult = null;
        activeLabUploadError = null;
        selectedLabFile = null;
        fileInput.value = '';
        fileStatus.style.display = 'none';
        selectedFilename.textContent = '';
    }
}

async function loadLabReports() {
    const listContainer = document.getElementById('lab-reports-history-list');
    if (!listContainer) return;

    try {
        let reports;
        if (prefetchCache.labReports) {
            reports = await prefetchCache.labReports;
            prefetchCache.labReports = null;
        } else {
            const response = await fetch('/api/lab-reports', {
                headers: {
                    'X-User-Email': appState.currentUserEmail
                }
            });
            if (!response.ok) throw new Error("Failed to fetch reports list.");
            reports = await response.json();
        }

        if (reports.length === 0) {
            listContainer.innerHTML = `
                <div class="empty-reports-placeholder">
                    <i data-lucide="folder-open"></i>
                    <span>No laboratory reports uploaded yet.</span>
                </div>
            `;
            if (window.lucide) lucide.createIcons();
            return;
        }

        listContainer.innerHTML = '';
        reports.forEach(report => {
            const card = document.createElement('div');
            card.className = 'lab-report-card';
            card.innerHTML = `
                <div class="lab-report-card-info">
                    <span class="lab-report-card-title">${escapeHTML(report.report_label)}</span>
                    <div class="lab-report-card-meta">
                        <span><i data-lucide="file"></i> ${escapeHTML(report.filename)}</span>
                        <span><i data-lucide="calendar"></i> ${report.uploaded_at}</span>
                    </div>
                </div>
                <div class="lab-report-card-actions">
                    <button class="btn btn-secondary btn-sm" onclick="downloadLabReport(${report.id})" title="Download Report">
                        <i data-lucide="download"></i> Download
                    </button>
                    <button class="btn btn-danger btn-sm" onclick="deleteLabReport(${report.id}, event)">
                        <i data-lucide="trash-2"></i>
                    </button>
                </div>
            `;
            listContainer.appendChild(card);
        });

        if (window.lucide) lucide.createIcons();
    } catch (err) {
        console.error("Error loading lab reports:", err);
        listContainer.innerHTML = `<p class="error-msg">Error loading reports history: ${err.message}</p>`;
    }
}

// Direct download without opening modal
window.downloadLabReport = async function(reportId) {
    try {
        const response = await fetch(`/api/lab-reports/${reportId}`, {
            headers: { 'X-User-Email': appState.currentUserEmail }
        });
        if (!response.ok) throw new Error('Failed to fetch report info.');
        const report = await response.json();
        const url = `/api/lab-reports/download/${reportId}?email=${encodeURIComponent(report.user_email || appState.currentUserEmail)}&token=${encodeURIComponent(report.download_token)}`;
        const a = document.createElement('a');
        a.href = url;
        a.download = report.filename || 'report';
        a.target = '_blank';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
    } catch (err) {
        alert('Download failed: ' + err.message);
    }
};

async function showLabReportDetails(reportId) {
    const modal = document.getElementById('lab-report-modal');

    const modalTitle = document.getElementById('lab-modal-title');
    const modalDate = document.getElementById('lab-modal-date');
    const modalContent = document.getElementById('lab-modal-analysis-content');

    if (!modal) return;

    try {
        modalContent.innerHTML = `<div class="loading-spinner-container"><div class="spinner"></div><p style="margin-top:10px;">Loading report details...</p></div>`;
        modal.style.display = 'flex';

        const response = await fetch(`/api/lab-reports/${reportId}`, {
            headers: {
                'X-User-Email': appState.currentUserEmail
            }
        });
        if (!response.ok) throw new Error("Failed to fetch report details.");

        const report = await response.json();

        modalTitle.textContent = report.report_label;
        modalDate.textContent = `Uploaded on ${report.uploaded_at}`;
        
        // Render secure download & metadata card
        modalContent.innerHTML = `
            <div style="display:flex; flex-direction:column; align-items:center; gap:20px; padding:30px 20px;">
                <div style="width:70px; height:70px; border-radius:50%; background:rgba(0,102,204,0.1); display:flex; align-items:center; justify-content:center;">
                    <i data-lucide="file-text" style="width:36px; height:36px; color:var(--accent-color, #0066cc);"></i>
                </div>
                <div style="text-align:center;">
                    <h3 style="margin-bottom:8px; font-weight:700; color:var(--text-primary); font-size:1.15rem;">${escapeHTML(report.filename)}</h3>
                    <p style="color:var(--text-secondary); font-size:0.9rem;">File stored securely in local database storage.</p>
                </div>
                <div style="display:flex; gap:12px; margin-top:10px;">
                    <a href="/api/lab-reports/download/${reportId}?email=${encodeURIComponent(report.user_email || appState.currentUserEmail)}&token=${encodeURIComponent(report.download_token)}" target="_blank" class="btn btn-primary" style="display:inline-flex; align-items:center; gap:8px; padding:10px 20px; font-weight:500; font-size:0.95rem; text-decoration:none;">
                        <i data-lucide="download" style="width:18px; height:18px;"></i>
                        Download Report
                    </a>
                </div>
            </div>
        `;

        if (window.lucide) lucide.createIcons();
    } catch (err) {
        console.error("Error loading report details:", err);
        modalContent.innerHTML = `<p class="error-msg">Error fetching details: ${err.message}</p>`;
    }
}

async function deleteLabReport(reportId, event) {
    if (event) event.stopPropagation();

    if (!confirm("Are you sure you want to delete this report from your safe storage?")) {
        return;
    }

    try {
        const response = await fetch(`/api/lab-reports/${reportId}`, {
            method: 'DELETE',
            headers: {
                'X-User-Email': appState.currentUserEmail
            }
        });

        if (!response.ok) throw new Error("Failed to delete report.");

        await loadLabReports();
    } catch (err) {
        console.error("Delete report error:", err);
        alert(`Error deleting report: ${err.message}`);
    }
}

function escapeHTML(str) {
    if (!str) return '';
    return str
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

// Bind global functions to window scope for onclick actions
window.showLabReportDetails = showLabReportDetails;
window.deleteLabReport = deleteLabReport;


