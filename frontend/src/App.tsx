// src/App.tsx
import React, { useState, useEffect, useRef, useCallback } from 'react';
import FocusCamera, { type MLResult } from './FocusCamera';
import { Play, Square, Activity, AlertTriangle, ShieldCheck, Clock, Eye, UserCheck } from 'lucide-react';
import './App.css';

const BACKEND_URL = 'http://localhost:5000';

// Audio chime synthesized with Web Audio API for distractions
const playDistractionChime = () => {
  try {
    const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = 'sine';
    osc.frequency.setValueAtTime(440, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(220, ctx.currentTime + 0.3);

    gain.gain.setValueAtTime(0.2, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.3);

    osc.connect(gain);
    gain.connect(ctx.destination);

    osc.start();
    osc.stop(ctx.currentTime + 0.3);
  } catch (e) {
    // Ignore audio autoplay restrictions if unhandled
  }
};

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
    }
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
        // Cooldown 3s between audio alerts
        if (now - lastEventTimeRef.current > 3000) {
          lastEventTimeRef.current = now;
          playDistractionChime();
          setDistractionCount((prev) => prev + 1);
          setLatestEvent('distraction');

          const newLogItem = {
            id: now,
            time: new Date().toLocaleTimeString(),
            type: result.details?.reason || 'Отвлечение внимания',
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
          <div className="logo-icon">🧠</div>
          <div>
            <h1>Personal AI Focus Coach</h1>
            <p className="subtitle">Анализ концентрации и позы в реальном времени</p>
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
                  <span>Пожалуйста, верните внимание к работе.</span>
                </div>
              </div>
            )}
          </div>

          {/* Session Control Buttons */}
          <div className="controls-card">
            {!isSessionActive ? (
              <button className="btn btn-primary" onClick={handleStartSession}>
                <Play className="btn-icon" /> Начать сессию фокусировки
              </button>
            ) : (
              <button className="btn btn-danger" onClick={handleStopSession}>
                <Square className="btn-icon" /> Завершить сессию
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
                <AlertTriangle className="m-icon text-red" /> Отвлечений
              </div>
              <div className="metric-value">{distractionCount}</div>
            </div>
          </div>

          {/* Realtime Computer Vision Telemetry */}
          <div className="card telemetry-card">
            <div className="card-header">
              <Eye className="card-icon" />
              <h3>ML Метрики</h3>
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
                <span>Состояние рта:</span>
                <strong className={details.mouth_state && details.mouth_state.includes('Зевота') ? 'text-red' : 'text-green'}>
                  {details.mouth_state || 'Норма'}
                </strong>
              </div>
              <div className="telemetry-item">
                <span>Причина / Статус:</span>
                <strong className={currentScore < 60 ? 'text-red' : 'text-green'}>
                  {details.reason || 'Внимание удержано'}
                </strong>
              </div>
              <div className="telemetry-item">
                <span>Движок:</span>
                <span className="mode-badge">{details.mode || 'Multi-Factor MediaPipe Engine'}</span>
              </div>
            </div>
          </div>

          {/* Distraction Event Log */}
          <div className="card history-card">
            <div className="card-header">
              <UserCheck className="card-icon" />
              <h3>История отвлечений</h3>
            </div>
            {eventLog.length === 0 ? (
              <p className="empty-log">Отвлечений пока не зафиксировано 👍</p>
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
