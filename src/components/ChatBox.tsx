import React, { useEffect, useState } from 'react';
import socket from '../services/socket';
import './ChatPage.scss';

const ChatPage: React.FC = () => {
  const [message, setMessage] = useState('');
  const [messages, setMessages] = useState<string[]>([]);
  const room = 'general';

  useEffect(() => {
    socket.emit('join-room', room);

    socket.on('receive-message', (msg: string) => {
      setMessages(prev => [...prev, msg]);
    });

    return () => {
      socket.off('receive-message');
    };
  }, []);

  const sendMessage = () => {
    socket.emit('send-message', { room, message });
    setMessages(prev => [...prev, `You: ${message}`]);
    setMessage('');
  };

  return (
    <div className="chat-page">
      <h2>Room: {room}</h2>
      <div className="chat-box">
        {messages.map((m, i) => <p key={i}>{m}</p>)}
      </div>
      <input value={message} onChange={(e) => setMessage(e.target.value)} />
      <button onClick={sendMessage}>Send</button>
    </div>
  );
};

export default ChatPage;
