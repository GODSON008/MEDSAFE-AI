/**
 * MedSafe AI — Healthcare Hospital Scene Animation Engine
 * 60FPS HTML5 Canvas rendering modern hospital building, looping ambulance,
 * background car traffic, sidewalk pedestrians, sky clouds, and streetlights.
 */

(function () {
    const canvas = document.createElement('canvas');
    canvas.id = 'hospital-scene-canvas';
    canvas.style.position = 'absolute';
    canvas.style.top = '0';
    canvas.style.left = '0';
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    canvas.style.zIndex = '1';
    canvas.style.pointerEvents = 'none';

    const overlay = document.getElementById('login-screen-overlay');
    if (overlay) {
        overlay.insertBefore(canvas, overlay.firstChild);
    } else {
        document.body.appendChild(canvas);
    }

    const ctx = canvas.getContext('2d');
    let width = 0;
    let height = 0;

    function resize() {
        width = canvas.width = window.innerWidth;
        height = canvas.height = window.innerHeight;
    }
    window.addEventListener('resize', resize);
    resize();

    // ── Animation Engine Configuration ───────────────────────────────────────
    // Easily customize traffic speeds, car counts, park durations, and asset modes
    const CONFIG = (window.HOSPITAL_SCENE_CONFIG = {
        numBackgroundCars: 3,           // Number of looping street cars
        carBaseSpeed: 2.2,             // Base speed for background road traffic
        ambulanceSpeed: 3.5,           // Drive-in speed for emergency ambulance
        ambulanceParkDurationMs: 2500, // Parked duration at entrance gate (ms)
        pedestrianCount: 3,            // Number of sidewalk walking characters
        enableStreetlights: true,      // Toggle glowing streetlight halos
        enableClouds: true             // Toggle drifting sky clouds
    });

    // ── Environmental State ───────────────────────────────────────────────────
    const clouds = [
        { x: width * 0.1, y: height * 0.12, r: 35, speed: 0.25 },
        { x: width * 0.45, y: height * 0.08, r: 45, speed: 0.18 },
        { x: width * 0.8, y: height * 0.15, r: 40, speed: 0.3 }
    ];

    // ── Background Cars State ────────────────────────────────────────────────
    const bgCars = [
        { x: -120, laneY: 0.62, speed: 2.2, color: '#38bdf8', type: 'sedan' },
        { x: width + 100, laneY: 0.65, speed: -1.8, color: '#94a3b8', type: 'suv' },
        { x: -300, laneY: 0.62, speed: 2.6, color: '#f1f5f9', type: 'hatchback' }
    ];

    // ── Ambulance Looping State Machine ───────────────────────────────────────
    const ambulance = {
        x: -250,
        y: 0,
        targetX: 0,
        speed: 3.5,
        state: 'DRIVING_IN', // DRIVING_IN, DECELERATING, PARKED, DRIVING_OUT, RESET_WAIT
        parkTimer: 0,
        resetTimer: 0,
        sirenFlash: false,
        sirenTick: 0
    };

    // ── Pedestrians State ─────────────────────────────────────────────────────
    const pedestrians = [
        { x: width * 0.15, y: 0, speed: 0.8, role: 'doctor', stride: 0 },
        { x: width * 0.75, y: 0, speed: -0.7, role: 'nurse', stride: 0 },
        { x: width * 0.35, y: 0, speed: 0.6, role: 'visitor', stride: 0 }
    ];

    // ── Draw Sky & Background ─────────────────────────────────────────────────
    function drawSky() {
        const grad = ctx.createLinearGradient(0, 0, 0, height);
        grad.addColorStop(0, '#e0f2fe');   // Light sky blue
        grad.addColorStop(0.5, '#f0f9ff'); // Soft horizon white-blue
        grad.addColorStop(1, '#e2e8f0');   // Ground transition
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, width, height);

        // Sun glow
        const sunGrad = ctx.createRadialGradient(width * 0.85, height * 0.15, 10, width * 0.85, height * 0.15, 180);
        sunGrad.addColorStop(0, 'rgba(255, 253, 231, 0.9)');
        sunGrad.addColorStop(0.4, 'rgba(254, 240, 138, 0.3)');
        sunGrad.addColorStop(1, 'rgba(255, 255, 255, 0)');
        ctx.fillStyle = sunGrad;
        ctx.fillRect(0, 0, width, height);
    }

    function drawClouds() {
        ctx.fillStyle = 'rgba(255, 255, 255, 0.85)';
        clouds.forEach(c => {
            c.x += c.speed;
            if (c.x - c.r * 2 > width) c.x = -c.r * 2;

            ctx.beginPath();
            ctx.arc(c.x, c.y, c.r, 0, Math.PI * 2);
            ctx.arc(c.x + c.r * 0.7, c.y - c.r * 0.3, c.r * 0.8, 0, Math.PI * 2);
            ctx.arc(c.x + c.r * 1.4, c.y, c.r * 0.7, 0, Math.PI * 2);
            ctx.fill();
        });
    }

    // ── Draw Hospital Building ────────────────────────────────────────────────
    function drawHospitalBuilding() {
        const bY = height * 0.22;
        const bH = height * 0.42;
        const bW = width * 0.7;
        const bX = (width - bW) / 2;

    // ── Draw Hospital Building ────────────────────────────────────────────────
    function drawHospitalBuilding() {
        const bY = height * 0.18;
        const bH = height * 0.46;
        const bW = width * 0.78;
        const bX = (width - bW) / 2;

        // Main Hospital Block Shadow
        ctx.fillStyle = 'rgba(15, 23, 42, 0.1)';
        ctx.fillRect(bX - 12, bY + 12, bW + 24, bH);

        // Main Structure Body
        ctx.fillStyle = '#f8fafc'; // Crisp healthcare white
        ctx.fillRect(bX, bY, bW, bH);

        // Top Roof Accent & Parapet (Medical Cyan)
        ctx.fillStyle = '#0284c7';
        ctx.fillRect(bX, bY, bW, 16);

        // Windows Grid
        ctx.fillStyle = 'rgba(14, 165, 233, 0.35)';
        const rows = 5;
        const cols = 14;
        const wW = (bW - 80) / cols;
        const wH = (bH - 130) / rows;

        for (let r = 0; r < rows; r++) {
            for (let c = 0; c < cols; c++) {
                const wx = bX + 40 + c * wW + c * 2;
                const wy = bY + 45 + r * wH + r * 6;
                ctx.fillRect(wx, wy, wW - 4, wH - 4);

                // Window glass glare highlight
                ctx.fillStyle = 'rgba(255, 255, 255, 0.45)';
                ctx.fillRect(wx, wy, (wW - 4) * 0.45, 2);
                ctx.fillStyle = 'rgba(14, 165, 233, 0.35)';
            }
        }

        // Entrance Center Canopy
        const cW = bW * 0.38;
        const cX = bX + (bW - cW) / 2;
        const cY = bY + bH - 65;

        ctx.fillStyle = '#e2e8f0';
        ctx.fillRect(cX, cY, cW, 65);

        // Building Sign: "+ CITY HOSPITAL"
        const sW = cW * 0.92;
        const sX = cX + (cW - sW) / 2;
        const sY = cY - 32;

        ctx.fillStyle = '#0284c7';
        ctx.fillRect(sX, sY, sW, 32);

        // Red Medical Cross Logo
        ctx.fillStyle = '#ef4444';
        ctx.fillRect(sX + 16, sY + 7, 18, 18);
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(sX + 22, sY + 9, 6, 14);
        ctx.fillRect(sX + 18, sY + 13, 14, 6);

        // Hospital Sign Text
        ctx.fillStyle = '#ffffff';
        ctx.font = 'bold 15px Outfit, Inter, sans-serif';
        ctx.fillText('CITY HOSPITAL', sX + 44, sY + 22);

        // Glass Automatic Doors
        ctx.fillStyle = 'rgba(15, 23, 42, 0.75)';
        ctx.fillRect(cX + 24, cY + 12, cW - 48, 53);

        ctx.strokeStyle = '#38bdf8';
        ctx.lineWidth = 2;
        ctx.strokeRect(cX + 24, cY + 12, cW - 48, 53);
        ctx.beginPath();
        ctx.moveTo(cX + cW / 2, cY + 12);
        ctx.lineTo(cX + cW / 2, cY + 65);
        ctx.stroke();
    }

    // ── Draw Grounds & Long Straight Horizontal Road ──────────────────────────
    function drawGroundAndRoads() {
        const rY1 = height * 0.65; // Background upper street
        const rY2 = height * 0.76; // Long Straight Horizontal Road

        // Lawn & Garden Ground
        ctx.fillStyle = '#86efac'; // Fresh healthcare spring green
        ctx.fillRect(0, height * 0.62, width, height * 0.38);

        // Sidewalk Paving Tiles (Straight horizontal path)
        ctx.fillStyle = '#cbd5e1';
        ctx.fillRect(0, rY2 - 28, width, 28);
        // Tile Grid Lines
        ctx.strokeStyle = '#94a3b8';
        ctx.lineWidth = 1;
        for (let sx = 0; sx < width; sx += 40) {
            ctx.beginPath();
            ctx.moveTo(sx, rY2 - 28);
            ctx.lineTo(sx, rY2);
            ctx.stroke();
        }

        // Upper Background Street
        ctx.fillStyle = '#475569';
        ctx.fillRect(0, rY1, width, 30);

        // LONG STRAIGHT HORIZONTAL MAIN ROAD (Spans 100% of viewport width)
        ctx.fillStyle = '#1e293b';
        ctx.fillRect(0, rY2, width, 75);

        // Double Solid Yellow Center Line
        ctx.strokeStyle = '#facc15';
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        ctx.moveTo(0, rY2 + 35);
        ctx.lineTo(width, rY2 + 35);
        ctx.moveTo(0, rY2 + 39);
        ctx.lineTo(width, rY2 + 39);
        ctx.stroke();

        // White Dashed Lane Lines
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 2;
        ctx.setLineDash([20, 20]);
        ctx.beginPath();
        ctx.moveTo(0, rY2 + 18);
        ctx.lineTo(width, rY2 + 18);
        ctx.moveTo(0, rY2 + 56);
        ctx.lineTo(width, rY2 + 56);
        ctx.stroke();
        ctx.setLineDash([]);

        // Streetlights along straight horizontal road
        const lightPositions = [width * 0.08, width * 0.32, width * 0.55, width * 0.78, width * 0.95];
        lightPositions.forEach(lx => {
            // Metallic Pole
            ctx.fillStyle = '#64748b';
            ctx.fillRect(lx, rY2 - 55, 5, 55);
            // Lamp Head
            ctx.fillRect(lx - 6, rY2 - 60, 16, 6);
            // Glowing Light Halo
            const lGrad = ctx.createRadialGradient(lx + 2, rY2 - 57, 2, lx + 2, rY2 - 57, 28);
            lGrad.addColorStop(0, 'rgba(254, 240, 138, 0.85)');
            lGrad.addColorStop(1, 'rgba(254, 240, 138, 0)');
            ctx.fillStyle = lGrad;
            ctx.fillRect(lx - 28, rY2 - 70, 60, 60);
        });

        // Trees & Cherry Blossom Bushes
        const treePositions = [width * 0.04, width * 0.2, width * 0.75, width * 0.92];
        treePositions.forEach(tx => {
            ctx.fillStyle = '#78350f';
            ctx.fillRect(tx, rY1 - 42, 9, 28);
            ctx.fillStyle = '#22c55e';
            ctx.beginPath();
            ctx.arc(tx + 4, rY1 - 48, 22, 0, Math.PI * 2);
            ctx.fill();
            ctx.fillStyle = '#16a34a';
            ctx.beginPath();
            ctx.arc(tx - 5, rY1 - 42, 16, 0, Math.PI * 2);
            ctx.fill();
        });
    }

    // ── Draw Vehicles ─────────────────────────────────────────────────────────
    function drawBackgroundCars() {
        bgCars.forEach(car => {
            car.x += car.speed;
            if (car.speed > 0 && car.x > width + 100) car.x = -150;
            if (car.speed < 0 && car.x < -150) car.x = width + 100;

            const cY = height * car.laneY;
            const cW = 55;
            const cH = 22;

            // Vehicle Shadow
            ctx.fillStyle = 'rgba(0,0,0,0.25)';
            ctx.fillRect(car.x + 2, cY + cH - 2, cW - 4, 4);

            // Car Body
            ctx.fillStyle = car.color;
            ctx.beginPath();
            ctx.roundRect(car.x, cY, cW, cH, [4, 8, 4, 4]);
            ctx.fill();

            // Cabin Roof
            ctx.fillStyle = '#1e293b';
            ctx.beginPath();
            ctx.roundRect(car.x + 12, cY - 8, 30, 10, [4, 4, 0, 0]);
            ctx.fill();

            // Wheels
            ctx.fillStyle = '#0f172a';
            ctx.beginPath();
            ctx.arc(car.x + 12, cY + cH, 5, 0, Math.PI * 2);
            ctx.arc(car.x + cW - 12, cY + cH, 5, 0, Math.PI * 2);
            ctx.fill();
        });
    }

    function drawAmbulance() {
        const aY = height * 0.775;
        ambulance.targetX = width * 0.48; // Main entrance gate center

        // State Machine Step
        if (ambulance.state === 'DRIVING_IN') {
            ambulance.x += ambulance.speed;
            if (ambulance.x >= ambulance.targetX - 80) {
                ambulance.state = 'DECELERATING';
            }
        } else if (ambulance.state === 'DECELERATING') {
            ambulance.x += 1.2;
            if (ambulance.x >= ambulance.targetX) {
                ambulance.state = 'PARKED';
                ambulance.parkTimer = 150; // ~2.5 seconds at 60fps
            }
        } else if (ambulance.state === 'PARKED') {
            ambulance.parkTimer--;
            if (ambulance.parkTimer <= 0) {
                ambulance.state = 'DRIVING_OUT';
            }
        } else if (ambulance.state === 'DRIVING_OUT') {
            ambulance.x += 4.2;
            if (ambulance.x > width + 200) {
                ambulance.state = 'RESET_WAIT';
                ambulance.resetTimer = 60; // 1 second reset wait
            }
        } else if (ambulance.state === 'RESET_WAIT') {
            ambulance.resetTimer--;
            if (ambulance.resetTimer <= 0) {
                ambulance.x = -250;
                ambulance.state = 'DRIVING_IN';
            }
        }

        // Siren Lightbar Pulse
        ambulance.sirenTick++;
        if (ambulance.sirenTick % 12 === 0) {
            ambulance.sirenFlash = !ambulance.sirenFlash;
        }

        const aW = 90;
        const aH = 38;
        const aX = ambulance.x;

        // Vehicle Shadow
        ctx.fillStyle = 'rgba(0,0,0,0.35)';
        ctx.fillRect(aX + 4, aY + aH - 2, aW - 8, 6);

        // Main White Body
        ctx.fillStyle = '#ffffff';
        ctx.beginPath();
        ctx.roundRect(aX, aY, aW, aH, [6, 12, 4, 4]);
        ctx.fill();

        // Red EMS Stripe
        ctx.fillStyle = '#ef4444';
        ctx.fillRect(aX, aY + 18, aW, 8);

        // Emergency Text
        ctx.fillStyle = '#ffffff';
        ctx.font = '900 9px Outfit, sans-serif';
        ctx.fillText('AMBULANCE', aX + 18, aY + 25);

        // Cabin Window
        ctx.fillStyle = '#0f172a';
        ctx.beginPath();
        ctx.roundRect(aX + aW - 28, aY + 5, 22, 14, [2, 6, 2, 2]);
        ctx.fill();

        // Wheels
        ctx.fillStyle = '#1e293b';
        ctx.beginPath();
        ctx.arc(aX + 18, aY + aH, 7, 0, Math.PI * 2);
        ctx.arc(aX + aW - 18, aY + aH, 7, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#94a3b8';
        ctx.beginPath();
        ctx.arc(aX + 18, aY + aH, 3, 0, Math.PI * 2);
        ctx.arc(aX + aW - 18, aY + aH, 3, 0, Math.PI * 2);
        ctx.fill();

        // Siren Lightbar
        ctx.fillStyle = '#334155';
        ctx.fillRect(aX + 30, aY - 6, 25, 6);

        ctx.fillStyle = ambulance.sirenFlash ? '#ef4444' : '#3b82f6';
        ctx.fillRect(aX + 32, aY - 6, 10, 5);

        ctx.fillStyle = ambulance.sirenFlash ? '#3b82f6' : '#ef4444';
        ctx.fillRect(aX + 43, aY - 6, 10, 5);

        // Siren Flashing Light Halos
        if (ambulance.state === 'PARKED' || ambulance.state === 'DECELERATING' || ambulance.state === 'DRIVING_IN') {
            const sGrad = ctx.createRadialGradient(aX + 42, aY - 6, 2, aX + 42, aY - 6, 30);
            sGrad.addColorStop(0, ambulance.sirenFlash ? 'rgba(239, 68, 68, 0.75)' : 'rgba(59, 130, 246, 0.75)');
            sGrad.addColorStop(1, 'rgba(0,0,0,0)');
            ctx.fillStyle = sGrad;
            ctx.fillRect(aX + 12, aY - 35, 60, 60);
        }
    }

    // ── Draw Pedestrians ──────────────────────────────────────────────────────
    function drawPedestrians() {
        const pY = height * 0.74;

        pedestrians.forEach(p => {
            p.x += p.speed;
            p.stride += 0.15;
            if (p.speed > 0 && p.x > width + 50) p.x = -50;
            if (p.speed < 0 && p.x < -50) p.x = width + 50;

            const legAngle = Math.sin(p.stride) * 6;

            // Head
            ctx.fillStyle = p.role === 'doctor' ? '#f87171' : '#fde047';
            ctx.beginPath();
            ctx.arc(p.x, pY - 24, 4.5, 0, Math.PI * 2);
            ctx.fill();

            // Torso
            ctx.fillStyle = p.role === 'doctor' ? '#0284c7' : (p.role === 'nurse' ? '#0d9488' : '#6366f1');
            ctx.fillRect(p.x - 4, pY - 18, 8, 12);

            // Walking Legs
            ctx.strokeStyle = '#1e293b';
            ctx.lineWidth = 2.5;
            ctx.beginPath();
            ctx.moveTo(p.x - 2, pY - 6);
            ctx.lineTo(p.x - 2 + legAngle, pY + 6);
            ctx.moveTo(p.x + 2, pY - 6);
            ctx.lineTo(p.x + 2 - legAngle, pY + 6);
            ctx.stroke();
        });
    }

    // ── Main Animation Render Loop ────────────────────────────────────────────
    function animate() {
        ctx.clearRect(0, 0, width, height);

        drawSky();
        drawClouds();
        drawHospitalBuilding();
        drawGroundAndRoads();
        drawAmbulance();

        requestAnimationFrame(animate);
    }

    animate();
})();
