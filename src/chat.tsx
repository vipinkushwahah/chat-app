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
  const [inGroupCall, setInGroupCall] = useState(false);

  const localVideoRef = useRef<HTMLVideoElement>(null);
  const remoteVideosRef = useRef<HTMLDivElement>(null);
  const localStream = useRef<MediaStream | null>(null);
  const peerConnections = useRef<{ [userId: string]: RTCPeerConnection }>({});

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

    socket.on('group_call_offer', async ({ from, offer }) => {
      const pc = createPeerConnection(from);
      peerConnections.current[from] = pc;

      await setupMedia();
      await pc.setRemoteDescription(new RTCSessionDescription(offer));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);

      socket.emit('group_call_answer', { to: from, answer });
    });

    socket.on('group_call_answer', async ({ from, answer }) => {
      const pc = peerConnections.current[from];
      await pc?.setRemoteDescription(new RTCSessionDescription(answer));
    });

    socket.on('group_ice_candidate', ({ from, candidate }) => {
      const pc = peerConnections.current[from];
      pc?.addIceCandidate(new RTCIceCandidate(candidate));
    });

    socket.on('call_ended', () => {
      endGroupCall();
    });

    return () => {
      socket.off('receive_message');
      socket.off('user_list');
      socket.off('group_call_offer');
      socket.off('group_call_answer');
      socket.off('group_ice_candidate');
      socket.off('call_ended');
    };
  }, [joinedGroup]);

  const setupMedia = async () => {
    if (localStream.current) return;

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      localStream.current = stream;
      if (localVideoRef.current) {
        localVideoRef.current.srcObject = stream;
        localVideoRef.current.muted = true;
        await localVideoRef.current.play();
      }
    } catch (err) {
      console.error('Media access error:', err);
      alert('Please allow camera and microphone access.');
    }
  };

  const createPeerConnection = (userId: string) => {
    const pc = new RTCPeerConnection(servers);

    pc.onicecandidate = (e) => {
      if (e.candidate) {
        socket.emit('group_ice_candidate', { to: userId, candidate: e.candidate });
      }
    };

    pc.ontrack = (event) => {
      const remoteVideo = document.createElement('video');
      remoteVideo.autoplay = true;
      remoteVideo.playsInline = true;
      remoteVideo.srcObject = event.streams[0];
      remoteVideo.className = 'video';
      remoteVideo.setAttribute('data-user', userId);
      remoteVideosRef.current?.appendChild(remoteVideo);
    };

    localStream.current?.getTracks().forEach(track => pc.addTrack(track, localStream.current!));
    return pc;
  };

  const handleRegister = () => {
    if (username) {
      socket.emit('register', username);
      setRegistered(true);
    }
  };

  const joinGroupHandler = () => {
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

  const startGroupCall = async () => {
    await setupMedia();
    setInGroupCall(true);

    socket.emit('get_group_members', joinedGroup, async (groupUsers: string[]) => {
      const otherUsers = groupUsers.filter(u => u !== username);
      for (const user of otherUsers) {
        const pc = createPeerConnection(user);
        peerConnections.current[user] = pc;

        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);

        socket.emit('group_call_offer', { to: user, offer, group: joinedGroup });
      }
    });
  };

  const endGroupCall = () => {
    Object.values(peerConnections.current).forEach(pc => pc.close());
    peerConnections.current = {};

    localStream.current?.getTracks().forEach(track => track.stop());
    localStream.current = null;

    if (localVideoRef.current) localVideoRef.current.srcObject = null;
    if (remoteVideosRef.current) remoteVideosRef.current.innerHTML = '';

    socket.emit('end_group_call', { group: joinedGroup });
    setInGroupCall(false);
  };

  const toggleAudio = () => {
    localStream.current?.getAudioTracks().forEach(track => track.enabled = !track.enabled);
  };

  const toggleVideo = () => {
    localStream.current?.getVideoTracks().forEach(track => track.enabled = !track.enabled);
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
            <button onClick={joinGroupHandler}>Join Group</button>

            <h3>Group Video Call</h3>
            <button onClick={startGroupCall} disabled={!joinedGroup || inGroupCall}>Start Call</button>
            {inGroupCall && (
              <>
                <button onClick={endGroupCall}>End Call</button>
                <button onClick={toggleAudio}>Toggle Mic</button>
                <button onClick={toggleVideo}>Toggle Video</button>
              </>
            )}
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
              <div ref={remoteVideosRef} className="remote-videos" />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default Chat;