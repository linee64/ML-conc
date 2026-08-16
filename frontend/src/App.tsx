// src/App.tsx
import React, { useState, useEffect, useRef, useCallback } from 'react';
import FocusCamera, { type MLResult } from './FocusCamera';
import { Play, Square, Activity, AlertTriangle, ShieldCheck, Clock, Eye, UserCheck } from 'lucide-react';
import { Howl } from 'howler';
import './App.css';

const BACKEND_URL = 'http://localhost:5000';

// Audio punishment (Gazan - Sixseven)
const punishmentAudio = new Howl({
  src: ['/audio/sixseven.mp3'],
  volume: 1.0,
  html5: true // Force HTML5 audio to bypass some browser autoplay policies
});

const App: React.FC = () => {
  const [isConnected, setIsConnected] = useState<boolean>(false);
  const [isSessionActive, setIsSessionActive] = useState<boolean>(false);
  const [sessionSeconds, setSessionSeconds] = useState<number>(0);
  const [currentScore, setCurrentScore] = useState<number>(85);
  const [distractionCount, setDistractionCount] = useState<number>(0);
  const [latestEvent, setLatestEvent] = useState<string | null>(null);
  const [details, setDetails] = useState<any>({});
  const [eventLog, setEventLog] = useState<{ id: number; time: string; type: string; score: number }[]>([]);

  const lastEventTimeRef = useRef<number>(0);

  // Deep work timer
  useEffect(() => {
    let timer: any;
    if (isSessionActive) {
      timer = setInterval(() => {
        setSessionSeconds((prev) => prev + 1);
      }, 1000);
    }
    return () => clearInterval(timer);
  }, [isSessionActive]);

  // Handle Session Start
  const handleStartSession = async () => {
    try {
      const res = await fetch(`${BACKEND_URL}/api/session/start`, { method: 'POST' });
      const data = await res.json();
      if (data.success) {
        setIsSessionActive(true);
        setSessionSeconds(0);
        setDistractionCount(0);
        setEventLog([]);
        
        // Pre-load/unlock audio context on user interaction
        if (Howler.ctx && Howler.ctx.state === 'suspended') {
          Howler.ctx.resume();
        }
      }
    } catch (e) {
      console.error('Session start error:', e);
      // Fallback local start if backend is starting
      setIsSessionActive(true);
    }
  };

  // Handle Session Stop
  const handleStopSession = async () => {
    try {
      await fetch(`${BACKEND_URL}/api/session/stop`, { method: 'POST' });
    } catch (e) {
      console.error('Session stop error:', e);
    } finally {
      setIsSessionActive(false);
      setCurrentScore(100);
      setLatestEvent(null);
      setDetails({ reason: 'Сессия остановлена' });
      punishmentAudio.stop();
    }
  };

  // Trigger McDonald's penalty (immediately opens vacancy, 5 sec later plays Gazan song)
  const triggerVibeCoderPenalty = () => {
    // 1. Immediately open McDonald's / Vkusno i Tochka job application
    try {
      window.open('https://rabota.vkusnoitochka.ru/', '_blank');
    } catch (e) {
      console.error('Failed to open tab:', e);
    }

    // 2. Exactly 5 seconds later play Gazan song
    setTimeout(() => {
      try {
        if (!punishmentAudio.playing()) {
          punishmentAudio.play();
        }
      } catch (err) {
        console.error('Audio playback error:', err);
      }
    }, 5000);
  };

  // Handle ML results from FocusCamera
  const handleMLResult = useCallback(
    (result: MLResult) => {
      if (result.score !== undefined) {
        setCurrentScore(result.score);
      }

      if (result.details) {
        setDetails(result.details);
      }

      if (result.event === 'distraction') {
        const now = Date.now();
        // Cooldown 15s between extreme penalties to prevent tab bomb
        if (now - lastEventTimeRef.current > 15000) {
          lastEventTimeRef.current = now;
          
          triggerVibeCoderPenalty();
          
          setDistractionCount((prev) => prev + 1);
          setLatestEvent('distraction');

          const newLogItem = {
            id: now,
            time: new Date().toLocaleTimeString(),
            type: result.details?.reason || 'Отвлечение внимания (Штраф Макдональдс)',
            score: result.score,
          };
          setEventLog((prev) => [newLogItem, ...prev.slice(0, 9)]);
        }
      } else {
        setLatestEvent(null);
      }
    },
    []
  );

  // Format seconds to mm:ss
  const formatTime = (totalSec: number) => {
    const mins = Math.floor(totalSec / 60);
    const secs = totalSec % 60;
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  };

  return (
    <div className="app-root">
      {/* Header Bar */}
      <header className="app-header">
        <div className="title-box">
          <div className="logo-icon">🍔</div>
          <div>
            <h1>Vibecoder Focus AI</h1>
            <p className="subtitle">Отвлекся? Добро пожаловать во «Вкусно — и точка»!</p>
          </div>
        </div>

        <div className="connection-badge">
          <span className={`status-dot ${isConnected ? 'online' : 'offline'}`} />
          {isConnected ? 'Бэкенд подключен (WS: 5000)' : 'Поиск сервера...'}
        </div>
      </header>

      {/* Main Dashboard Layout */}
      <div className="dashboard-grid">
        {/* Left Column: Live Camera & Alerts */}
        <div className="main-panel">
          <div className="camera-card">
            <FocusCamera
              onResult={handleMLResult}
              onConnectionChange={setIsConnected}
              backendUrl={BACKEND_URL}
              isActive={isSessionActive}
            />

            {latestEvent && (
              <div className="alert-banner distraction-alert">
                <AlertTriangle className="alert-icon" />
                <div>
                  <strong>Обнаружено отвлечение!</strong>
                  <span>Песня запущена, анкета на работу открыта. Удачи!</span>
                </div>
              </div>
            )}
          </div>

          {/* Session Control Buttons */}
          <div className="controls-card">
            {!isSessionActive ? (
              <button className="btn btn-primary" onClick={handleStartSession}>
                <Play className="btn-icon" /> Начать хардкор сессию
              </button>
            ) : (
              <button className="btn btn-danger" onClick={handleStopSession}>
                <Square className="btn-icon" /> Сдаться (Завершить)
              </button>
            )}

            <div className="session-timer">
              <Clock className="timer-icon" />
              <span>Длительность: <strong>{formatTime(sessionSeconds)}</strong></span>
            </div>
          </div>
        </div>

        {/* Right Column: Statistics & ML Details */}
        <div className="side-panel">
          {/* Focus Score Card */}
          <div className="card score-card">
            <div className="card-header">
              <Activity className="card-icon" />
              <h3>Уровень концентрации</h3>
            </div>
            <div className="score-display">
              <div
                className={`score-circle ${
                  currentScore < 50 ? 'red' : currentScore < 75 ? 'yellow' : 'green'
                }`}
              >
                <span className="number">{currentScore}</span>
                <span className="unit">%</span>
              </div>
              <div className="score-progress-bg">
                <div
                  className={`score-progress-bar ${
                    currentScore < 50 ? 'bg-red' : currentScore < 75 ? 'bg-yellow' : 'bg-green'
                  }`}
                  style={{ width: `${currentScore}%` }}
                />
              </div>
            </div>
          </div>

          {/* Summary Metrics */}
          <div className="metrics-grid">
            <div className="metric-box">
              <div className="metric-title">
                <ShieldCheck className="m-icon text-green" /> Сессия
              </div>
              <div className="metric-value">{isSessionActive ? 'Активна' : 'Пауза'}</div>
            </div>

            <div className="metric-box">
              <div className="metric-title">
                <AlertTriangle className="m-icon text-red" /> Штрафов
              </div>
              <div className="metric-value">{distractionCount}</div>
            </div>
          </div>

          {/* Realtime Computer Vision Telemetry */}
          <div className="card telemetry-card">
            <div className="card-header">
              <Eye className="card-icon" />
              <h3>ML Метрики (Контроль)</h3>
            </div>
            <div className="telemetry-list">
              <div className="telemetry-item">
                <span>Направление взгляда:</span>
                <strong className={details.gaze_direction && details.gaze_direction !== 'Прямо' ? 'text-red' : 'text-green'}>
                  {details.gaze_direction || 'Прямо на экран'}
                </strong>
              </div>
              <div className="telemetry-item">
                <span>Позиция головы:</span>
                <strong className={details.head_pose && details.head_pose !== 'Центр' ? 'text-red' : 'text-green'}>
                  {details.head_pose || 'Центр'}
                </strong>
              </div>
              <div className="telemetry-item">
                <span>Состояние глаз:</span>
                <strong className={details.eye_state && details.eye_state.includes('Закрыты') ? 'text-red' : 'text-green'}>
                  {details.eye_state || 'Открыты'}
                </strong>
              </div>
              <div className="telemetry-item">
                <span>Причина / Статус:</span>
                <strong className={currentScore < 60 ? 'text-red' : 'text-green'}>
                  {details.reason || 'Внимание удержано'}
                </strong>
              </div>
            </div>
          </div>

          {/* Distraction Event Log */}
          <div className="card history-card">
            <div className="card-header">
              <UserCheck className="card-icon" />
              <h3>История провалов</h3>
            </div>
            {eventLog.length === 0 ? (
              <p className="empty-log">Пока держишься 👍</p>
            ) : (
              <ul className="log-list">
                {eventLog.map((log) => (
                  <li key={log.id} className="log-item">
                    <span className="log-time">{log.time}</span>
                    <span className="log-type">{log.type}</span>
                    <span className="log-score">{log.score}%</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

export default App;

