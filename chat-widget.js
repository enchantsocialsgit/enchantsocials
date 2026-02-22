/**
 * Ascend Agency — Floating AI Chat Widget
 * Drop-in lead capture + product demo
 * Include via: <script src="chat-widget.js" defer></script>
 */
(function() {
    'use strict';

    const ACCENT = '#8b5cf6';
    const ACCENT_DARK = '#7c3aed';
    const BG = '#111118';
    const BG_LIGHT = '#1a1a24';
    const GREEN = '#4ade80';

    // Conversation trees per niche
    const FLOWS = {
        law: [
            { from: 'bot', text: "Hi! I'm Ascend's AI assistant. I help law firms capture more clients with 24/7 automation. What type of law does your firm practice?", quick: ['Personal Injury', 'Family Law', 'Criminal Defense', 'Other'] },
            { from: 'bot', text: "Great — {practice_type} firms are one of our specialties. The biggest issue we see is missed calls and slow intake. On average, 50% of calls to small firms go unanswered. Does that resonate?", quick: ['Yes, we miss calls', 'We have a receptionist', 'Tell me more'] },
            { from: 'bot', text: "Here's what we deploy in 48 hours: an AI that answers your phone and website 24/7, qualifies the case, captures details, and books consultations on your calendar. One firm went from 22 to 31 consultations per month. Would you like to see how it works for {practice_type} specifically?" , quick: ['Yes, show me', 'What does it cost?'] },
            { from: 'bot', text: "Perfect. Drop your name and email below and we'll send you a personalized demo video for your practice — plus a free audit of your current lead flow.", capture: true },
            { from: 'bot', text: "Thanks! You'll receive your personalized demo within 24 hours. In the meantime, you can book a live strategy call at ascendagency.site/book", final: true }
        ],
        re: [
            { from: 'bot', text: "Hi! I'm Ascend's AI assistant. I help real estate agents capture and convert more leads automatically. Are you a solo agent or part of a team?", quick: ['Solo agent', 'Small team (2-5)', 'Brokerage / large team'] },
            { from: 'bot', text: "Got it. The #1 challenge for {agent_type} is speed-to-lead. Agents who respond in under 5 minutes are 100x more likely to convert — but the average response time is 4+ hours. Sound familiar?", quick: ['Yes, leads slip away', 'I respond fast already', 'Tell me more'] },
            { from: 'bot', text: "We build an AI system that responds to every inquiry — DMs, texts, web forms, calls — in under 60 seconds, 24/7. It qualifies the lead and books showings on your calendar. One agent booked 12 extra showings the first week. Want to see it in action?", quick: ['Yes, show me', 'What does it cost?'] },
            { from: 'bot', text: "Drop your name and email below and we'll send you a personalized walkthrough — plus a free lead response audit for your market.", capture: true },
            { from: 'bot', text: "Thanks! Check your inbox within 24 hours. You can also book a live strategy call at ascendagency.site/book", final: true }
        ],
        general: [
            { from: 'bot', text: "Hi! I'm Ascend's AI assistant. We build AI automation for law firms and real estate practices. Which best describes you?", quick: ['Law firm', 'Real estate agent', 'Other business'] },
        ]
    };

    let state = {
        open: false,
        flow: null,
        step: 0,
        vars: {},
        captured: false
    };

    function injectStyles() {
        const style = document.createElement('style');
        style.textContent = `
            #ascend-chat-bubble {
                position: fixed; bottom: 24px; right: 24px; z-index: 9999;
                width: 60px; height: 60px; border-radius: 50%;
                background: ${ACCENT}; border: none;
                box-shadow: 0 4px 20px rgba(139,92,246,0.4), 0 0 0 0 rgba(139,92,246,0.3);
                cursor: pointer; display: flex; align-items: center; justify-content: center;
                transition: transform 0.3s, box-shadow 0.3s;
                animation: acw-pulse 3s ease-in-out infinite;
            }
            #ascend-chat-bubble:hover { transform: scale(1.08); box-shadow: 0 6px 28px rgba(139,92,246,0.5); }
            #ascend-chat-bubble svg { width: 28px; height: 28px; fill: #fff; transition: transform 0.3s; }
            #ascend-chat-bubble.open svg { transform: rotate(90deg); }
            @keyframes acw-pulse {
                0%, 100% { box-shadow: 0 4px 20px rgba(139,92,246,0.4), 0 0 0 0 rgba(139,92,246,0.3); }
                50% { box-shadow: 0 4px 20px rgba(139,92,246,0.4), 0 0 0 12px rgba(139,92,246,0); }
            }

            #ascend-chat-badge {
                position: absolute; top: -2px; right: -2px;
                width: 18px; height: 18px; border-radius: 50%;
                background: #ef4444; border: 2px solid #111;
                font-size: 10px; font-weight: 700; color: #fff;
                display: flex; align-items: center; justify-content: center;
            }

            #ascend-chat-window {
                position: fixed; bottom: 96px; right: 24px; z-index: 9998;
                width: 380px; max-height: 520px;
                background: ${BG}; border: 1px solid rgba(255,255,255,0.08);
                border-radius: 20px; overflow: hidden;
                box-shadow: 0 20px 60px rgba(0,0,0,0.6);
                transform: scale(0.9) translateY(20px); opacity: 0;
                pointer-events: none; transition: transform 0.35s cubic-bezier(0.34,1.56,0.64,1), opacity 0.25s;
                display: flex; flex-direction: column;
                font-family: 'Inter', -apple-system, system-ui, sans-serif;
            }
            #ascend-chat-window.open {
                transform: scale(1) translateY(0); opacity: 1; pointer-events: all;
            }

            .acw-header {
                padding: 16px 20px; display: flex; align-items: center; gap: 12px;
                background: linear-gradient(135deg, ${ACCENT}, ${ACCENT_DARK});
                flex-shrink: 0;
            }
            .acw-avatar {
                width: 36px; height: 36px; border-radius: 50%;
                background: rgba(255,255,255,0.2); display: flex;
                align-items: center; justify-content: center; font-size: 18px; flex-shrink: 0;
            }
            .acw-header-info { flex: 1; }
            .acw-header-info h4 { font-size: 14px; font-weight: 700; color: #fff; margin: 0; }
            .acw-header-info p { font-size: 11px; color: rgba(255,255,255,0.8); margin: 2px 0 0; }
            .acw-online { display: inline-block; width: 8px; height: 8px; background: ${GREEN}; border-radius: 50%; margin-right: 4px; animation: acw-blink 2s infinite; }
            @keyframes acw-blink { 0%,100% { opacity: 1; } 50% { opacity: 0.4; } }
            .acw-close {
                background: rgba(255,255,255,0.15); border: none; border-radius: 50%;
                width: 28px; height: 28px; display: flex; align-items: center; justify-content: center;
                cursor: pointer; color: #fff; font-size: 16px; line-height: 1; flex-shrink: 0;
            }
            .acw-close:hover { background: rgba(255,255,255,0.25); }

            .acw-body {
                flex: 1; overflow-y: auto; padding: 16px; display: flex;
                flex-direction: column; gap: 10px; min-height: 300px; max-height: 360px;
                scroll-behavior: smooth;
            }
            .acw-body::-webkit-scrollbar { width: 4px; }
            .acw-body::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.1); border-radius: 4px; }

            .acw-msg {
                max-width: 88%; padding: 10px 14px; border-radius: 14px;
                font-size: 13px; line-height: 1.55; animation: acw-fadeIn 0.3s ease;
            }
            .acw-msg-bot {
                background: ${BG_LIGHT}; border: 1px solid rgba(255,255,255,0.06);
                color: #d4d4d8; align-self: flex-start; border-bottom-left-radius: 4px;
            }
            .acw-msg-user {
                background: rgba(139,92,246,0.2); border: 1px solid rgba(139,92,246,0.2);
                color: #e0d4ff; align-self: flex-end; border-bottom-right-radius: 4px;
            }
            @keyframes acw-fadeIn { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }

            .acw-typing {
                display: inline-flex; gap: 4px; padding: 12px 16px; align-self: flex-start;
                background: ${BG_LIGHT}; border-radius: 14px; border-bottom-left-radius: 4px;
            }
            .acw-typing span {
                width: 6px; height: 6px; border-radius: 50%; background: rgba(255,255,255,0.3);
                animation: acw-bounce 1.4s infinite;
            }
            .acw-typing span:nth-child(2) { animation-delay: 0.2s; }
            .acw-typing span:nth-child(3) { animation-delay: 0.4s; }
            @keyframes acw-bounce { 0%,60%,100% { transform: translateY(0); } 30% { transform: translateY(-5px); } }

            .acw-quick-replies {
                display: flex; flex-wrap: wrap; gap: 6px; margin-top: 6px;
                animation: acw-fadeIn 0.3s ease 0.1s both;
            }
            .acw-quick-btn {
                padding: 8px 14px; border-radius: 20px;
                border: 1px solid rgba(139,92,246,0.3); background: transparent;
                color: #a78bfa; font-size: 12px; font-weight: 500;
                cursor: pointer; transition: all 0.2s;
                font-family: inherit;
            }
            .acw-quick-btn:hover { background: rgba(139,92,246,0.15); border-color: ${ACCENT}; color: #c4b5fd; }

            .acw-capture-form {
                display: flex; flex-direction: column; gap: 8px; margin-top: 8px;
                animation: acw-fadeIn 0.3s ease;
            }
            .acw-capture-form input {
                padding: 10px 14px; border-radius: 10px;
                border: 1px solid rgba(255,255,255,0.1); background: rgba(255,255,255,0.04);
                color: #f0f0f0; font-size: 13px; font-family: inherit; outline: none;
            }
            .acw-capture-form input:focus { border-color: rgba(139,92,246,0.4); }
            .acw-capture-form input::placeholder { color: #555; }
            .acw-capture-submit {
                padding: 10px 20px; border-radius: 10px; border: none;
                background: ${ACCENT}; color: #fff; font-size: 13px;
                font-weight: 600; cursor: pointer; font-family: inherit;
                transition: background 0.2s;
            }
            .acw-capture-submit:hover { background: ${ACCENT_DARK}; }

            .acw-footer {
                padding: 10px 16px; border-top: 1px solid rgba(255,255,255,0.05);
                text-align: center; flex-shrink: 0;
            }
            .acw-footer a {
                font-size: 11px; color: #555; text-decoration: none;
            }
            .acw-footer a:hover { color: #888; }

            @media (max-width: 480px) {
                #ascend-chat-window {
                    width: calc(100vw - 24px); right: 12px; bottom: 88px;
                    max-height: 70vh; border-radius: 16px;
                }
                #ascend-chat-bubble { bottom: 16px; right: 16px; width: 54px; height: 54px; }
                #ascend-chat-bubble svg { width: 24px; height: 24px; }
            }
        `;
        document.head.appendChild(style);
    }

    function createElements() {
        // Chat bubble
        const bubble = document.createElement('button');
        bubble.id = 'ascend-chat-bubble';
        bubble.setAttribute('aria-label', 'Chat with AI assistant');
        bubble.innerHTML = `
            <svg viewBox="0 0 24 24"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
            <div id="ascend-chat-badge">1</div>
        `;
        document.body.appendChild(bubble);

        // Chat window
        const win = document.createElement('div');
        win.id = 'ascend-chat-window';
        win.innerHTML = `
            <div class="acw-header">
                <div class="acw-avatar">🤖</div>
                <div class="acw-header-info">
                    <h4>Ascend AI</h4>
                    <p><span class="acw-online"></span>Online now</p>
                </div>
                <button class="acw-close" aria-label="Close chat">&times;</button>
            </div>
            <div class="acw-body" id="acw-body"></div>
            <div class="acw-footer">
                <a href="https://ascendagency.site" target="_blank">Powered by Ascend Agency</a>
            </div>
        `;
        document.body.appendChild(win);

        // Events
        bubble.addEventListener('click', toggleChat);
        win.querySelector('.acw-close').addEventListener('click', toggleChat);
    }

    function toggleChat() {
        state.open = !state.open;
        const win = document.getElementById('ascend-chat-window');
        const bubble = document.getElementById('ascend-chat-bubble');
        const badge = document.getElementById('ascend-chat-badge');

        win.classList.toggle('open', state.open);
        bubble.classList.toggle('open', state.open);

        if (badge) badge.style.display = 'none';

        // Start conversation on first open
        if (state.open && !state.flow) {
            state.flow = 'general';
            state.step = 0;
            setTimeout(() => showBotMessage(FLOWS.general[0]), 600);
        }
    }

    function showBotMessage(msg) {
        const body = document.getElementById('acw-body');

        // Show typing indicator
        const typing = document.createElement('div');
        typing.className = 'acw-typing';
        typing.innerHTML = '<span></span><span></span><span></span>';
        body.appendChild(typing);
        body.scrollTop = body.scrollHeight;

        // Replace typing with actual message after delay
        const delay = Math.min(msg.text.length * 15, 1800);
        setTimeout(() => {
            typing.remove();

            // Replace variables in text
            let text = msg.text;
            Object.entries(state.vars).forEach(([k, v]) => {
                text = text.replace(new RegExp('\\{' + k + '\\}', 'g'), v);
            });

            const msgEl = document.createElement('div');
            msgEl.className = 'acw-msg acw-msg-bot';
            msgEl.textContent = text;
            body.appendChild(msgEl);

            // Show quick replies
            if (msg.quick) {
                const qr = document.createElement('div');
                qr.className = 'acw-quick-replies';
                msg.quick.forEach(label => {
                    const btn = document.createElement('button');
                    btn.className = 'acw-quick-btn';
                    btn.textContent = label;
                    btn.addEventListener('click', () => handleQuickReply(label));
                    qr.appendChild(btn);
                });
                body.appendChild(qr);
            }

            // Show capture form
            if (msg.capture) {
                const form = document.createElement('div');
                form.className = 'acw-capture-form';
                form.innerHTML = `
                    <input type="text" id="acw-name" placeholder="Your name" required>
                    <input type="email" id="acw-email" placeholder="Your email" required>
                    <button class="acw-capture-submit">Send me the demo</button>
                `;
                body.appendChild(form);
                form.querySelector('.acw-capture-submit').addEventListener('click', handleCapture);
            }

            body.scrollTop = body.scrollHeight;
        }, delay);
    }

    function handleQuickReply(label) {
        const body = document.getElementById('acw-body');

        // Remove quick reply buttons
        const qrs = body.querySelectorAll('.acw-quick-replies');
        qrs.forEach(q => q.remove());

        // Show user message
        const userMsg = document.createElement('div');
        userMsg.className = 'acw-msg acw-msg-user';
        userMsg.textContent = label;
        body.appendChild(userMsg);
        body.scrollTop = body.scrollHeight;

        // Handle niche selection from general flow
        if (state.flow === 'general') {
            if (label === 'Law firm') {
                state.flow = 'law';
                state.step = 0;
                state.vars.practice_type = 'law';
                setTimeout(() => showBotMessage(FLOWS.law[0]), 800);
                return;
            } else if (label === 'Real estate agent') {
                state.flow = 're';
                state.step = 0;
                state.vars.agent_type = 'real estate agents';
                setTimeout(() => showBotMessage(FLOWS.re[0]), 800);
                return;
            } else {
                // Other business
                const otherMsg = {
                    from: 'bot',
                    text: "We currently specialize in law firms and real estate — but we're expanding. Drop your email and we'll reach out when we launch for your industry.",
                    capture: true
                };
                setTimeout(() => showBotMessage(otherMsg), 800);
                return;
            }
        }

        // Store variable based on step
        const flow = FLOWS[state.flow];
        if (state.flow === 'law' && state.step === 0) {
            state.vars.practice_type = label;
        } else if (state.flow === 're' && state.step === 0) {
            state.vars.agent_type = label.toLowerCase();
        }

        // Advance to next step
        state.step++;
        if (state.step < flow.length) {
            setTimeout(() => showBotMessage(flow[state.step]), 800);
        }
    }

    function handleCapture() {
        const name = document.getElementById('acw-name');
        const email = document.getElementById('acw-email');

        if (!name || !email || !name.value.trim() || !email.value.trim()) {
            if (email && !email.value.includes('@')) {
                email.style.borderColor = '#ef4444';
            }
            return;
        }

        state.captured = true;

        // Submit via formsubmit.co (same as other forms)
        const formData = new FormData();
        formData.append('name', name.value.trim());
        formData.append('email', email.value.trim());
        formData.append('_subject', 'Chat Widget Lead: ' + name.value.trim());
        formData.append('niche', state.flow || 'general');
        formData.append('source', 'chat-widget');
        formData.append('page', window.location.pathname);
        formData.append('_captcha', 'false');

        fetch('https://formsubmit.co/ajax/enchantsocials@gmail.com', {
            method: 'POST',
            body: formData
        }).catch(() => {});

        // Remove form, show thank you
        const body = document.getElementById('acw-body');
        const forms = body.querySelectorAll('.acw-capture-form');
        forms.forEach(f => f.remove());

        // Show user message
        const userMsg = document.createElement('div');
        userMsg.className = 'acw-msg acw-msg-user';
        userMsg.textContent = name.value.trim() + ' — ' + email.value.trim();
        body.appendChild(userMsg);

        // Show final message
        const flow = FLOWS[state.flow];
        const finalMsg = flow ? flow.find(m => m.final) : null;
        if (finalMsg) {
            setTimeout(() => showBotMessage(finalMsg), 800);
        } else {
            setTimeout(() => showBotMessage({
                from: 'bot',
                text: "Thanks " + name.value.trim() + "! We'll be in touch within 24 hours. You can also book a call now at ascendagency.site/book"
            }), 800);
        }
    }

    // Auto-open after 45 seconds on page (if not already interacted)
    function autoOpen() {
        if (!state.open && !state.flow) {
            const badge = document.getElementById('ascend-chat-badge');
            if (badge) badge.style.display = 'flex';
        }
    }

    // Init
    function init() {
        if (document.getElementById('ascend-chat-bubble')) return; // Prevent double-init
        injectStyles();
        createElements();
        setTimeout(autoOpen, 45000);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
