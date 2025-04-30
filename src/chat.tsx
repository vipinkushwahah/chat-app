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
  const [incomingCall, setIncomingCall] = useState<{ from: string; offer: RTCSessionDescriptionInit } | null>(null);
  const [isFrontCamera, setIsFrontCamera] = useState(true);
  const [remoteStreams, setRemoteStreams] = useState<Record<string, MediaStream>>({});

  const ringtone = useRef<HTMLAudioElement>(new Audio('/ringtone.mp3'));
  const localVideoRef = useRef<HTMLVideoElement>(null);
  const peerConnections = useRef<Record<string, RTCPeerConnection>>({});
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

    // Private call offer
    socket.on('call_user', async ({ from, offer }) => {
      setIncomingCall({ from, offer });
      ringtone.current.loop = true;
      ringtone.current.play().catch(() => {});
    });

    socket.on('answer_call', async ({ from, answer }) => {
      const pc = peerConnections.current[from];
      if (pc) await pc.setRemoteDescription(new RTCSessionDescription(answer));
    });

    socket.on('decline_call', ({ from }) => {
      alert(`${from} declined your call.`);
      endCallCleanup();
    });

    socket.on('ice_candidate', ({ from, candidate }) => {
      const pc = peerConnections.current[from];
      if (pc) pc.addIceCandidate(new RTCIceCandidate(candidate));
    });

    socket.on('end_call', () => {
      endCallCleanup();
    });

    // Group call offer/answer
    socket.on('group_call_offer', async ({ from, offer }) => {
      await setupMedia();
      const pc = createPeerConnection(from);
      await pc.setRemoteDescription(new RTCSessionDescription(offer));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      socket.emit('group_call_answer', { to: from, answer });
    });

    socket.on('group_call_answer', async ({ from, answer }) => {
      const pc = peerConnections.current[from];
      if (pc) await pc.setRemoteDescription(new RTCSessionDescription(answer));
    });

    return () => {
      socket.disconnect();
    };
  }, []);

  const setupMedia = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: isFrontCamera ? 'user' : 'environment' },
        audio: true,
      });
      localStream.current = stream;
      if (localVideoRef.current) {
        localVideoRef.current.srcObject = stream;
        localVideoRef.current.muted = true;
        await localVideoRef.current.play();
      }
    } catch (err) {
      console.error('Media access denied:', err);
      alert('Please allow camera and microphone access.');
    }
  };

  const createPeerConnection = (peerId: string) => {
    const pc = new RTCPeerConnection(servers);
    peerConnections.current[peerId] = pc;

    localStream.current?.getTracks().forEach(track => {
      pc.addTrack(track, localStream.current!);
    });

    pc.ontrack = (event) => {
      setRemoteStreams(prev => ({ ...prev, [peerId]: event.streams[0] }));
    };

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        socket.emit('ice_candidate', {
          to: peerId,
          candidate: event.candidate,
        });
      }
    };

    return pc;
  };

  const handleRegister = () => {
    if (username) {
      socket.connect();
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

  const startPrivateCall = async () => {
    if (!targetUser) return;
    await setupMedia();
    const pc = createPeerConnection(targetUser);
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    socket.emit('call_user', {
      to: targetUser,
      offer: pc.localDescription,
    });
    setInCall(true);
  };

  const answerCall = async () => {
    if (!incomingCall) return;
    ringtone.current.pause();
    await setupMedia();
    const pc = createPeerConnection(incomingCall.from);
    await pc.setRemoteDescription(new RTCSessionDescription(incomingCall.offer));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    socket.emit('answer_call', { to: incomingCall.from, answer });
    setIncomingCall(null);
    setInCall(true);
  };

  const declineCall = () => {
    if (incomingCall) {
      socket.emit('decline_call', { to: incomingCall.from });
      ringtone.current.pause();
      setIncomingCall(null);
    }
  };

  const startGroupCall = async () => {
    if (!joinedGroup) return;
    await setupMedia();
    setInCall(true);
    const groupMembers = users.filter(u => u !== username);
    for (const member of groupMembers) {
      const pc = createPeerConnection(member);
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      socket.emit('group_call_offer', {
        group: joinedGroup,
        to: member,
        offer: pc.localDescription,
      });
    }
  };

  const endCall = () => {
    socket.emit('end_call');
    endCallCleanup();
  };

  const endCallCleanup = () => {
    Object.values(peerConnections.current).forEach(pc => pc.close());
    peerConnections.current = {};
    localStream.current?.getTracks().forEach(track => track.stop());
    localStream.current = null;
    setRemoteStreams({});
    setInCall(false);
    setIncomingCall(null);
    if (localVideoRef.current) localVideoRef.current.srcObject = null;
  };

  const switchCamera = async () => {
    setIsFrontCamera(prev => !prev);
    if (!localStream.current) return;
    localStream.current.getTracks().forEach(track => track.stop());

    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: isFrontCamera ? 'environment' : 'user' },
      audio: true,
    });

    localStream.current = stream;
    if (localVideoRef.current) {
      localVideoRef.current.srcObject = stream;
      localVideoRef.current.muted = true;
      await localVideoRef.current.play();
    }

    Object.values(peerConnections.current).forEach(pc => {
      const videoSender = pc.getSenders().find(s => s.track?.kind === 'video');
      if (videoSender) {
        videoSender.replaceTrack(stream.getVideoTracks()[0]);
      }
    });
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
            <button onClick={startPrivateCall} disabled={!targetUser || inCall}>Private Call</button>

            <h3>Group</h3>
            <input placeholder="Group name" onChange={(e) => setGroup(e.target.value)} />
            <button onClick={joinGroup}>Join Group</button>

            <h3>Video Call</h3>
            <button onClick={startGroupCall} disabled={!joinedGroup || inCall}>Start Group Call</button>
            {inCall && <button onClick={endCall}>End Call</button>}
            {inCall && <button onClick={switchCamera}>Switch Camera</button>}
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

            <div className="video-call">
              <video ref={localVideoRef} autoPlay muted playsInline className="video" />
              {Object.entries(remoteStreams).map(([userId, stream]) => (
                <VideoPlayer key={userId} stream={stream} />
              ))}
            </div>

            {incomingCall && (
              <div className="incoming-call-dialog">
                <h3>Incoming Call from {incomingCall.from}</h3>
                <button onClick={answerCall}>Answer</button>
                <button onClick={declineCall}>Decline</button>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function VideoPlayer({ stream }: { stream: MediaStream }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    if (ref.current && stream) {
      ref.current.srcObject = stream;
    }
  }, [stream]);
  return <video ref={ref} autoPlay playsInline className="video" />;
}

export default Chat;
