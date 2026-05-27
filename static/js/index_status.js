(function () {
    const recapId = window.RECAP_STATUS_ID;
    if (!recapId) return;

    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${protocol}//${location.host}/ws/job/${recapId}`);

    ws.onmessage = (event) => {
        let message;
        try {
            message = JSON.parse(event.data);
        } catch (error) {
            console.warn('[recap status] invalid message', event.data);
            return;
        }

        console.log('[recap status]', message);
        if (message.status === 'done') {
            console.log('[recap status] ready:', message.ready_url);
        }
    };

    ws.onerror = (event) => {
        console.warn('[recap status] websocket error', event);
    };

    ws.onclose = () => {
        console.log('[recap status] closed');
    };
}());
