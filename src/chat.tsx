// Chat.tsx
import React, { useEffect, useRef, useState } from 'react';
import { io } from 'socket.io-client';
import './chat.scss';

const socket = io(import.meta.env.VITE_BACKEND_URL || 'http://localhost:5001');

type Message = {
  from: string;
  message: string;
  type: 'private' | 'group';
  group?: string;
};

function Chat() {
  const [username, setUsername] = useState('');
  const [registered, setRegistered] = useState(false);
  const [users, setUsers] = useState<string[]>([]);
  const [targetUser, setTargetUser] = useState('');
  const [group, setGroup] = useState('');
  const [joinedGroup, setJoinedGroup] = useState('');
  const [message, setMessage] = useState('');
  const [messages, setMessages] = useState<Message[]>([]);
  const [mode, setMode] = useState<'private' | 'group'>('private');
  const [inCall, setInCall] = useState(false);
  const [groupStreams, setGroupStreams] = useState<{ [user: string]: MediaStream }>({});

  const localVideoRef = useRef<HTMLVideoElement>(null);
  const remoteVideoRef = useRef<HTMLVideoElement>(null);
  const localStream = useRef<MediaStream | null>(null);
  const peerConnections = useRef<{ [user: string]: RTCPeerConnection }>({});

  const servers = {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      {
        urls: 'turn:openrelay.metered.ca:80',
        username: 'openrelayproject',
        credential: 'openrelayproject',
      },
    ],
  };

  useEffect(() => {
    socket.on('receive_message', (msg: Message) => setMessages(prev => [...prev, msg]));
    socket.on('user_list', (list: string[]) => setUsers(list));

    socket.on('incoming_call', async ({ from, offer }) => {
      const pc = new RTCPeerConnection(servers);
      peerConnections.current[from] = pc;
      await setupMedia();

      pc.ontrack = (event) => {
        if (remoteVideoRef.current) remoteVideoRef.current.srcObject = event.streams[0];
      };

      pc.onicecandidate = (e) => {
        if (e.candidate) socket.emit('ice_candidate', { to: from, candidate: e.candidate });
      };

      localStream.current?.getTracks().forEach(track => pc.addTrack(track, localStream.current!));

      await pc.setRemoteDescription(new RTCSessionDescription(offer));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      socket.emit('answer_call', { to: from, answer });
      setTargetUser(from);
      setInCall(true);
    });

    socket.on('call_answered', async ({ from, answer }) => {
      await peerConnections.current[from]?.setRemoteDescription(new RTCSessionDescription(answer));
      setInCall(true);
    });

    socket.on('ice_candidate', ({ from, candidate }) => {
      if (peerConnections.current[from]) {
        peerConnections.current[from].addIceCandidate(new RTCIceCandidate(candidate));
      }
    });

    socket.on('call_ended', () => endCallCleanup());

    socket.on('group_call_offer', async ({ from, group, offer }) => {
      const pc = new RTCPeerConnection(servers);
      peerConnections.current[from] = pc;
      await setupMedia();

      pc.ontrack = (event) => {
        setGroupStreams(prev => ({ ...prev, [from]: event.streams[0] }));
      };

      pc.onicecandidate = (e) => {
        if (e.candidate) {
          socket.emit('group_ice_candidate', { to: from, candidate: e.candidate });
        }
      };

      localStream.current?.getTracks().forEach(track => pc.addTrack(track, localStream.current!));

      await pc.setRemoteDescription(new RTCSessionDescription(offer));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      socket.emit('group_call_answer', { to: from, answer, group });

      setInCall(true);
    });

    socket.on('group_call_answer', async ({ from, answer }) => {
      await peerConnections.current[from]?.setRemoteDescription(new RTCSessionDescription(answer));
    });

    socket.on('group_ice_candidate', ({ from, candidate }) => {
      if (peerConnections.current[from]) {
        peerConnections.current[from].addIceCandidate(new RTCIceCandidate(candidate));
      }
    });

    return () => {
      socket.off('receive_message');
      socket.off('user_list');
      socket.off('incoming_call');
      socket.off('call_answered');
      socket.off('ice_candidate');
      socket.off('call_ended');
      socket.off('group_call_offer');
      socket.off('group_call_answer');
      socket.off('group_ice_candidate');
      socket.disconnect();
    };
  }, []);

  const setupMedia = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      localStream.current = stream;
      if (localVideoRef.current) {
        localVideoRef.current.srcObject = stream;
        localVideoRef.current.muted = true;
        await localVideoRef.current.play();
      }
    } catch (err) {
      alert('Media access denied');
      console.error(err);
    }
  };

  const endCallCleanup = () => {
    Object.values(peerConnections.current).forEach(pc => pc.close());
    peerConnections.current = {};
    localStream.current?.getTracks().forEach(track => track.stop());
    localStream.current = null;
    if (localVideoRef.current) localVideoRef.current.srcObject = null;
    if (remoteVideoRef.current) remoteVideoRef.current.srcObject = null;
    setGroupStreams({});
    setInCall(false);
  };

  const handleRegister = () => {
    if (username.trim()) {
      socket.emit('register', username);
      setRegistered(true);
    }
  };

  const joinGroup = () => {
    if (group.trim()) {
      socket.emit('join_group', group);
      setJoinedGroup(group);
      setMode('group');
    }
  };

  const sendMessage = () => {
    if (!message.trim()) return;
    if (mode === 'private') {
      socket.emit('private_message', { to: targetUser, message });
    } else {
      socket.emit('group_message', { group: joinedGroup, message });
    }
    setMessage('');
  };

  const startCall = async () => {
    if (!targetUser) return;
    const pc = new RTCPeerConnection(servers);
    peerConnections.current[targetUser] = pc;
    await setupMedia();

    pc.ontrack = (event) => {
      if (remoteVideoRef.current) remoteVideoRef.current.srcObject = event.streams[0];
    };

    pc.onicecandidate = (e) => {
      if (e.candidate) socket.emit('ice_candidate', { to: targetUser, candidate: e.candidate });
    };

    localStream.current?.getTracks().forEach(track => pc.addTrack(track, localStream.current!));
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    socket.emit('call_user', { to: targetUser, offer });
  };

  const startGroupCall = async () => {
    if (!joinedGroup) return;
    await setupMedia();
    const peers = users.filter(u => u !== username);

    for (const user of peers) {
      const pc = new RTCPeerConnection(servers);
      peerConnections.current[user] = pc;

      pc.onicecandidate = (e) => {
        if (e.candidate) {
          socket.emit('group_ice_candidate', { to: user, candidate: e.candidate });
        }
      };

      localStream.current?.getTracks().forEach(track => pc.addTrack(track, localStream.current!));
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      socket.emit('group_call_offer', { to: user, group: joinedGroup, offer });
    }
    setInCall(true);
  };

  const endCall = () => {
    if (mode === 'private') {
      socket.emit('end_call', { to: targetUser });
    }
    endCallCleanup();
  };

  return (
    <div className="chat-container">
      {!registered ? (
        <div className="login">
          <h2>Enter Username</h2>
          <input onChange={(e) => setUsername(e.target.value)} />
          <button onClick={handleRegister}>Join Chat</button>
        </div>
      ) : (
        <div className="chat-box">
          <div className="sidebar">
            <h3>Users</h3>
            <select onChange={(e) => { setTargetUser(e.target.value); setMode('private'); }}>
              <option value="">-- Select User --</option>
              {users.filter(u => u !== username).map(u => (
                <option key={u} value={u}>{u}</option>
              ))}
            </select>

            <h3>Group</h3>
            <input placeholder="Group name" onChange={(e) => setGroup(e.target.value)} />
            <button onClick={joinGroup}>Join Group</button>

            <h3>Video Call</h3>
            <button onClick={startCall} disabled={!targetUser || inCall}>Start Call</button>
            <button onClick={startGroupCall} disabled={!joinedGroup || inCall}>Start Group Call</button>
            {inCall && <button onClick={endCall}>End Call</button>}
          </div>

          <div className="chat-main">
            <h2>Chatting as: {username}</h2>
            <div className="messages">
              {messages.map((msg, idx) => (
                <div key={idx}>
                  <strong>{msg.type === 'group' ? `[${msg.group}] ${msg.from}` : msg.from}:</strong> {msg.message}

                </div>
              ))}
            </div>

            <div className="message-input">
              <input
                placeholder="Type a message..."
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && sendMessage()}
              />
              <button onClick={sendMessage}>Send</button>
            </div>

            <div className="video-grid">
              <video ref={localVideoRef} autoPlay muted playsInline className="video" />
              {mode === 'private' && inCall && <video ref={remoteVideoRef} autoPlay playsInline className="video" />}
              {mode === 'group' && Object.entries(groupStreams).map(([user, stream]) => (
                <video
                  key={user}
                  autoPlay
                  playsInline
                  className="video"
                  ref={(el) => { if (el) el.srcObject = stream; }}
                />
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default Chat;