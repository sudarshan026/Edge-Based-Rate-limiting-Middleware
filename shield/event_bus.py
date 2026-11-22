"""
Async event bus for the Shield service.

Design constraints:
  • Fire-and-forget publish — never blocks, never raises, adds no latency
  • Bounded queue per subscriber — drops oldest on overflow
  • Zero overhead when no subscribers are connected
"""
from __future__ import annotations

import asyncio
import time
from typing import Any


class EventBus:
    """In-process async event bus with bounded per-subscriber queues."""

    __slots__ = ("_subscribers", "_next_id", "_max_queue_size")

    def __init__(self, max_queue_size: int = 2048) -> None:
        self._subscribers: dict[int, asyncio.Queue] = {}
        self._next_id: int = 0
        self._max_queue_size = max_queue_size

    def publish(self, event_type: str, data: dict[str, Any]) -> None:
        """
        Broadcast an event to all subscribers.

        Fire-and-forget: never blocks, never raises, adds no measurable
        latency.  When a subscriber's queue is full the oldest event is
        silently dropped.
        """
        if not self._subscribers:
            return  # Fast path — zero cost when dashboard is not connected

        envelope: dict[str, Any] = {"type": event_type, "ts": time.time()}
        envelope.update(data)

        for queue in self._subscribers.values():
            try:
                queue.put_nowait(envelope)
            except asyncio.QueueFull:
                # Drop oldest to make room for the newest event
                try:
                    queue.get_nowait()
                except asyncio.QueueEmpty:
                    pass
                try:
                    queue.put_nowait(envelope)
                except asyncio.QueueFull:
                    pass  # Defensive — should not happen

    def subscribe(self) -> tuple[int, "asyncio.Queue[dict[str, Any]]"]:
        """Create a new subscription.  Returns ``(sub_id, queue)``."""
        sub_id = self._next_id
        self._next_id += 1
        queue: asyncio.Queue[dict[str, Any]] = asyncio.Queue(
            maxsize=self._max_queue_size,
        )
        self._subscribers[sub_id] = queue
        return sub_id, queue

    def unsubscribe(self, sub_id: int) -> None:
        """Remove a subscription and free its queue."""
        self._subscribers.pop(sub_id, None)

    @property
    def subscriber_count(self) -> int:
        return len(self._subscribers)
