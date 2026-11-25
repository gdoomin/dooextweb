"""Short-lived cache of profiles verified by Supabase, with request coalescing."""

import base64
import hashlib
import json
import threading
import time
from collections import OrderedDict
from concurrent.futures import Future


class VerifiedIdentityCache:
    def __init__(self, ttl=30, max_entries=512):
        self.ttl = ttl
        self.max_entries = max_entries
        self._cache = OrderedDict()
        self._pending = {}
        self._lock = threading.Lock()

    def get(self, token, loader, *, fresh=False):
        # The unverified exp only shortens the cache lifetime; it never grants
        # access. Every cache entry originates from a successful server lookup.
        try:
            encoded = token.split(".")[1]
            expires = float(json.loads(base64.urlsafe_b64decode(encoded + "=" * (-len(encoded) % 4)))["exp"])
        except (ValueError, KeyError, IndexError, TypeError):
            expires = 0
        if fresh or expires <= time.time():
            return loader()
        key = hashlib.sha256(token.encode("utf-8")).digest()
        with self._lock:
            cached = self._cache.get(key)
            if cached and cached[0] > time.monotonic():
                self._cache.move_to_end(key)
                return cached[1]
            pending = self._pending.get(key)
            owner = pending is None
            if owner:
                pending = Future()
                self._pending[key] = pending
        if not owner:
            return pending.result()
        try:
            profile = loader()
            lifetime = min(self.ttl, max(0, expires - time.time()))
            with self._lock:
                self._cache[key] = (time.monotonic() + lifetime, profile)
                self._cache.move_to_end(key)
                while len(self._cache) > self.max_entries:
                    self._cache.popitem(last=False)
            pending.set_result(profile)
            return profile
        except Exception as error:
            pending.set_exception(error)
            raise
        finally:
            with self._lock:
                self._pending.pop(key, None)
