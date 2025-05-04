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
  const remoteVideoRef = useRef<HTMLVideoElement>(null); // still used for private call
  const peerConnection = useRef<RTCPeerConnection | null>(null);
  const localStream = useRef<MediaStream | null>(null);

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
    socket.on('receive_message', (msg: Message) => {
      setMessages(prev => [...prev, msg]);
    });

    socket.on('user_list', (list: string[]) => {
      setUsers(list);
    });

    socket.on('incoming_call', async ({ from, offer }) => {
      peerConnection.current = new RTCPeerConnection(servers);
      await setupMedia();

      peerConnection.current.ontrack = (event) => {
        if (remoteVideoRef.current) {
          remoteVideoRef.current.srcObject = event.streams[0];
        }
      };

      peerConnection.current.onicecandidate = (e) => {
        if (e.candidate) {
          socket.emit('ice_candidate', { to: from, candidate: e.candidate });
        }
      };

      await peerConnection.current.setRemoteDescription(new RTCSessionDescription(offer));
      const answer = await peerConnection.current.createAnswer();
      await peerConnection.current.setLocalDescription(answer);
      socket.emit('answer_call', { to: from, answer });

      setTargetUser(from);
      setInCall(true);
    });

    socket.on('call_answered', async ({ answer }) => {
      await peerConnection.current?.setRemoteDescription(new RTCSessionDescription(answer));
      setInCall(true);
    });

    socket.on('ice_candidate', ({ candidate }) => {
      peerConnection.current?.addIceCandidate(new RTCIceCandidate(candidate));
    });

    socket.on('call_ended', () => {
      endCallCleanup();
    });

    // Group call handlers
    socket.on('group_call_offer', async ({ from, group, offer }) => {
      peerConnection.current = new RTCPeerConnection(servers);
      await setupMedia();

      peerConnection.current.ontrack = (event) => {
        setGroupStreams(prev => ({ ...prev, [from]: event.streams[0] }));
      };

      peerConnection.current.onicecandidate = (e) => {
        if (e.candidate) {
          socket.emit('ice_candidate', { to: from, candidate: e.candidate, group });
        }
      };

      await peerConnection.current.setRemoteDescription(new RTCSessionDescription(offer));
      const answer = await peerConnection.current.createAnswer();
      await peerConnection.current.setLocalDescription(answer);
      socket.emit('group_call_answer', { to: from, answer, group });

      setInCall(true);
    });

    socket.on('group_call_answer', async ({ from, answer }) => {
      await peerConnection.current?.setRemoteDescription(new RTCSessionDescription(answer));
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
    };
  }, []);

  const setupMedia = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'user' },
        audio: true,
      });

      localStream.current = stream;

      if (localVideoRef.current) {
        localVideoRef.current.srcObject = stream;
        localVideoRef.current.muted = true;
        await localVideoRef.current.play();
      }

      stream.getTracks().forEach(track => {
        peerConnection.current?.addTrack(track, stream);
      });
    } catch (err) {
      console.error('Media access denied:', err);
      alert('Please allow camera and microphone access.');
    }
  };

  const endCallCleanup = () => {
    peerConnection.current?.close();
    peerConnection.current = null;

    if (localStream.current) {
      localStream.current.getTracks().forEach(track => track.stop());
      localStream.current = null;
    }

    if (localVideoRef.current) localVideoRef.current.srcObject = null;
    if (remoteVideoRef.current) remoteVideoRef.current.srcObject = null;

    setGroupStreams({});
    setInCall(false);
  };

  const handleRegister = () => {
    if (username) {
      socket.emit('register', username);
      setRegistered(true);
    }
  };

  const joinGroup = () => {
    if (group) {
      socket.emit('join_group', group);
      setJoinedGroup(group);
      setMode('group');
    }
  };

  const sendMessage = () => {
    if (!message.trim()) return;
    if (mode === 'private' && targetUser) {
      socket.emit('private_message', { to: targetUser, message });
    } else if (mode === 'group' && joinedGroup) {
      socket.emit('group_message', { group: joinedGroup, message });
    }
    setMessage('');
  };

  const startCall = async () => {
    if (!targetUser) return;

    peerConnection.current = new RTCPeerConnection(servers);
    await setupMedia();

    peerConnection.current.ontrack = (event) => {
      if (remoteVideoRef.current) {
        remoteVideoRef.current.srcObject = event.streams[0];
      }
    };

    peerConnection.current.onicecandidate = (e) => {
      if (e.candidate) {
        socket.emit('ice_candidate', { to: targetUser, candidate: e.candidate });
      }
    };

    const offer = await peerConnection.current.createOffer();
    await peerConnection.current.setLocalDescription(offer);

    socket.emit('call_user', { to: targetUser, offer });
  };

  const startGroupCall = async () => {
    if (!joinedGroup) return;

    peerConnection.current = new RTCPeerConnection(servers);
    await setupMedia();

    peerConnection.current.ontrack = (event) => {
      const stream = event.streams[0];
      setGroupStreams(prev => ({ ...prev, unknown: stream }));
    };

    peerConnection.current.onicecandidate = (e) => {
      if (e.candidate) {
        socket.emit('ice_candidate', { group: joinedGroup, candidate: e.candidate });
      }
    };

    const offer = await peerConnection.current.createOffer();
    await peerConnection.current.setLocalDescription(offer);

    socket.emit('start_group_call', {
      group: joinedGroup,
      offer,
    });

    setInCall(true);
  };

  const endCall = () => {
    if (mode === 'private' && targetUser) {
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
              {users.filter(u => u !== username).map((u) => (
                <option key={u} value={u}>{u}</option>
              ))}
            </select>

            <h3>Group</h3>
            <input placeholder="Group name" onChange={(e) => setGroup(e.target.value)} />
            <button onClick={joinGroup}>Join Group</button>

            <h3>Video Call</h3>
            <button onClick={startCall} disabled={!targetUser || inCall}>Start Call with {targetUser}</button>
            <button onClick={startGroupCall} disabled={!joinedGroup || inCall}>Start Group Call</button>
            {inCall && <button onClick={endCall}>End Call</button>}
          </div>

          <div className="chat-main">
            <h2>Chatting as: {username}</h2>
            <div className="messages">
              {messages.map((msg, idx) => (
                <div key={idx}>
                  <strong>{msg.type === 'group' ? `[${msg.group}] ${msg.from}` : `${msg.from}`}:</strong> {msg.message}
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
                  ref={(el) => {
                    if (el) el.srcObject = stream;
                  }}
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
