import mqtt from 'mqtt';
import { logbook } from './logbook.js';

function retainedKey(message) {
  return [message.brokerId || 'default', message.profileId || 'homeassistant', message.uniqueId || message.configTopic].join('|');
}

function profileSignature(profile = {}) {
  return JSON.stringify({
    id: profile.id,
    name: profile.name,
    mode: profile.mode,
    brokerId: profile.brokerId,
    enabled: profile.enabled !== false,
    discoveryPrefix: profile.discoveryPrefix,
    component: profile.component,
    topicPrefix: profile.topicPrefix,
    stateTopicTemplate: profile.stateTopicTemplate,
    availabilityTopicTemplate: profile.availabilityTopicTemplate,
    discoveryTopicTemplate: profile.discoveryTopicTemplate
  });
}

export class MqttPublisher {
  constructor({ retainedDiscovery = [], onRetainedDiscoveryChange = null, onBrokerConnected = null } = {}) {
    this.client = null;
    this.clients = new Map();
    this.brokerStates = new Map();
    this.connectionSignature = null;
    this.status = 'disabled';
    this.lastError = null;
    this.retainedDiscovery = new Map((Array.isArray(retainedDiscovery) ? retainedDiscovery : [])
      .filter((entry) => entry && entry.key && entry.brokerId && entry.configTopic)
      .map((entry) => [entry.key, { ...entry }]));
    this.onRetainedDiscoveryChange = onRetainedDiscoveryChange;
    this.onBrokerConnected = onBrokerConnected;
  }

  connect(settings = {}) {
    const brokers = Array.isArray(settings.brokers) && settings.brokers.length
      ? settings.brokers
      : [{ id: 'default', name: 'Hauptbroker', ...settings }];
    const activeBrokers = brokers.filter((broker) => broker.enabled !== false && broker.url);
    const signature = JSON.stringify(activeBrokers.map((broker) => ({
      id: broker.id,
      url: broker.url,
      clientId: broker.clientId || 'gridvis2mqtt',
      username: broker.username || '',
      password: broker.password || ''
    })));

    if (this.connectionSignature === signature && (this.clients.size || !activeBrokers.length)) return;
    this.disconnect();
    this.connectionSignature = signature;
    if (!activeBrokers.length) {
      this.status = 'disabled';
      return;
    }

    this.status = 'connecting';
    for (const broker of activeBrokers) this.connectBroker(broker);
  }

  connectBroker(broker) {
    const client = mqtt.connect(broker.url, {
      clientId: broker.clientId || 'gridvis2mqtt',
      username: broker.username || undefined,
      password: broker.password || undefined,
      reconnectPeriod: 5000
    });
    const state = { id: broker.id, name: broker.name, status: 'connecting', connected: false, lastError: null };
    this.clients.set(broker.id, client);
    this.brokerStates.set(broker.id, state);
    if (!this.client) this.client = client;
    client.on('connect', () => {
      state.status = 'connected';
      state.connected = true;
      this.lastError = null;
      this.updateAggregateStatus();
      logbook.success('mqtt.connection', { brokerId: broker.id, status: 'connected' });
      Promise.resolve(this.onBrokerConnected?.(broker.id)).catch((error) => {
        state.lastError = error.message;
        this.lastError = error.message;
        this.updateAggregateStatus();
      });
    });
    client.on('reconnect', () => {
      state.status = 'reconnecting';
      state.connected = false;
      this.updateAggregateStatus();
      logbook.info('mqtt.connection', { brokerId: broker.id, status: 'reconnecting' });
    });
    client.on('error', (error) => {
      state.status = 'error';
      state.connected = false;
      state.lastError = error.message;
      this.lastError = error.message;
      this.updateAggregateStatus();
      logbook.error('mqtt.connection', { brokerId: broker.id, status: 'error', error: error.message });
    });
    client.on('close', () => {
      state.status = 'disconnected';
      state.connected = false;
      this.updateAggregateStatus();
      logbook.info('mqtt.connection', { brokerId: broker.id, status: 'disconnected' });
    });
  }

  updateAggregateStatus() {
    const states = [...this.brokerStates.values()];
    const connected = states.filter((state) => state.connected).length;
    if (!states.length) this.status = 'disabled';
    else if (connected === states.length) this.status = 'connected';
    else if (connected > 0) this.status = 'partial';
    else if (states.some((state) => ['connecting', 'reconnecting'].includes(state.status))) this.status = 'connecting';
    else if (states.some((state) => state.status === 'error')) this.status = 'error';
    else this.status = 'disconnected';
  }

  disconnect() {
    for (const client of this.clients.values()) client.end(true);
    this.clients.clear();
    this.brokerStates.clear();
    this.client = null;
    this.connectionSignature = null;
    this.status = 'disabled';
  }

  async testConnection(settings = {}, timeoutMs = 5000) {
    if (!settings.url) throw new Error('Für den MQTT-Test ist keine Broker-URL eingetragen.');

    const client = mqtt.connect(settings.url, {
      clientId: settings.clientId || 'gridvis2mqtt',
      username: settings.username || undefined,
      password: settings.password || undefined,
      reconnectPeriod: 0,
      connectTimeout: timeoutMs
    });

    return new Promise((resolve, reject) => {
      let settled = false;
      let timer;
      const finish = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        client.end(true);
        if (error) reject(error); else resolve({ connected: true });
      };
      timer = setTimeout(() => finish(new Error('MQTT-Broker antwortet nicht innerhalb des Testzeitraums.')), timeoutMs + 250);
      client.once('connect', () => finish());
      client.once('error', (error) => finish(new Error(`MQTT-Verbindung fehlgeschlagen: ${error.message}`)));
      client.once('close', () => finish(new Error('MQTT-Broker hat die Testverbindung geschlossen.')));
    });
  }

  get connected() {
    return [...this.clients.values()].some((client) => client.connected);
  }

  isBrokerConnected(brokerId) {
    const client = brokerId ? this.clients.get(brokerId) : this.client;
    return Boolean(client?.connected);
  }

  hasRetainedDiscovery(message) {
    const entry = this.retainedDiscovery.get(retainedKey(message));
    return Boolean(entry
      && entry.active !== false
      && entry.configTopic === message.configTopic
      && entry.availabilityTopic === (message.availabilityTopic || '')
      && entry.stateTopic === (message.stateTopic || '')
      && JSON.stringify(entry.payload) === JSON.stringify(message.payload)
      && entry.stateRetain === (message.stateRetain === true)
      && (entry.availabilityValue || 'online') === (message.availabilityValue === 'offline' ? 'offline' : 'online')
      && entry.availabilityRetain === true);
  }

  notifyRetainedDiscoveryChange() {
    this.onRetainedDiscoveryChange?.([...this.retainedDiscovery.values()].map((entry) => ({ ...entry })));
  }

  async clearRetainedEntry(entry, { discovery = true, state = true } = {}) {
    const topics = discovery ? [entry.configTopic, entry.availabilityTopic] : [];
    if (state && entry.stateRetain === true && entry.stateTopic) topics.push(entry.stateTopic);
    if (Array.isArray(entry.cleanupTopics)) topics.push(...entry.cleanupTopics);
    const uniqueTopics = [...new Set(topics.filter(Boolean))];
    for (const topic of uniqueTopics) await this.publish(topic, '', { retain: true }, entry.brokerId);
  }

  async replayRetainedDiscovery(brokerId) {
    await this.cleanupInactiveRetainedDiscovery(brokerId);
    let changed = false;
    for (const entry of [...this.retainedDiscovery.values()]) {
      if (entry.brokerId !== brokerId) continue;
      if (entry.cleanupTopics?.length) {
        const currentDiscoveryTopics = new Set([entry.configTopic, entry.availabilityTopic].filter(Boolean));
        for (const topic of entry.cleanupTopics) {
          if (!currentDiscoveryTopics.has(topic)) await this.publish(topic, '', { retain: true }, brokerId);
        }
        entry.cleanupTopics = [];
        changed = true;
      }
      await this.publish(entry.configTopic, entry.payload, { retain: true }, brokerId);
      if (entry.availabilityTopic) {
        await this.publish(entry.availabilityTopic, entry.availabilityValue || 'online', { retain: true }, brokerId);
        entry.availabilityRetain = true;
        changed = true;
      }
      if (entry.stateRetain && entry.stateTopic && entry.statePayload !== undefined) {
        await this.publish(entry.stateTopic, entry.statePayload, { retain: true }, brokerId);
      }
    }
    if (changed) this.notifyRetainedDiscoveryChange();
  }

  async cleanupInactiveRetainedDiscovery(brokerId) {
    let changed = false;
    for (const entry of [...this.retainedDiscovery.values()]) {
      if (entry.brokerId !== brokerId || entry.active !== false) continue;
      await this.clearRetainedEntry(entry);
      this.retainedDiscovery.delete(entry.key);
      changed = true;
    }
    if (changed) this.notifyRetainedDiscoveryChange();
  }

  async reconcileRetainedDiscovery(activeKeys = new Set()) {
    let changed = false;
    for (const entry of this.retainedDiscovery.values()) {
      if (activeKeys.has(entry.key)) {
        if (entry.active === false) {
          entry.active = true;
          changed = true;
        }
        continue;
      }
      if (entry.active !== false) {
        entry.active = false;
        changed = true;
      }
    }
    if (!changed) return;
    for (const brokerId of this.clients.keys()) {
      if (this.isBrokerConnected(brokerId)) await this.cleanupInactiveRetainedDiscovery(brokerId);
    }
    this.notifyRetainedDiscoveryChange();
  }

  async markProfilesChanged(previousProfiles = [], nextProfiles = []) {
    const previous = new Map(previousProfiles.map((profile) => [profile.id, profile]));
    const next = new Map(nextProfiles.map((profile) => [profile.id, profile]));
    let changed = false;
    for (const entry of this.retainedDiscovery.values()) {
      const oldProfile = previous.get(entry.profileId);
      const nextProfile = next.get(entry.profileId);
      if (!nextProfile || nextProfile.enabled === false || profileSignature(oldProfile) !== profileSignature(nextProfile)) {
        entry.active = false;
        changed = true;
      }
    }
    if (!changed) return;
    for (const brokerId of this.clients.keys()) {
      if (this.isBrokerConnected(brokerId)) await this.cleanupInactiveRetainedDiscovery(brokerId);
    }
    this.notifyRetainedDiscoveryChange();
  }

  async publish(topic, payload, options = {}, brokerId = '') {
    const client = brokerId ? this.clients.get(brokerId) : this.client;
    if (!client) throw new Error('Der ausgewählte MQTT-Broker ist nicht konfiguriert.');
    if (!client.connected) throw new Error('Der ausgewählte MQTT-Broker ist noch nicht verbunden.');
    const message = typeof payload === 'string' ? payload : JSON.stringify(payload);
    const publishOptions = {
      qos: options.qos ?? 1,
      retain: options.retain ?? false
    };
    const startedAt = Date.now();
    try {
      await new Promise((resolve, reject) => {
        client.publish(topic, message, publishOptions, (error) => error ? reject(error) : resolve());
      });
      logbook.success('mqtt.publish', {
        brokerId: brokerId || 'default',
        topic,
        qos: publishOptions.qos,
        retain: publishOptions.retain,
        payloadBytes: Buffer.byteLength(message),
        durationMs: Date.now() - startedAt
      });
    } catch (error) {
      logbook.error('mqtt.publish', {
        brokerId: brokerId || 'default',
        topic,
        qos: publishOptions.qos,
        retain: publishOptions.retain,
        durationMs: Date.now() - startedAt,
        error: error.message
      });
      throw error;
    }
  }

  async publishDiscovery(messages, { force = false } = {}) {
    let changed = false;
    let published = 0;
    let queued = 0;
    for (const message of messages) {
      const key = retainedKey(message);
      const previous = this.retainedDiscovery.get(key);
      const connected = this.isBrokerConnected(message.brokerId);
      const unchanged = previous
        && previous.active !== false
        && previous.configTopic === message.configTopic
        && previous.availabilityTopic === (message.availabilityTopic || '')
        && previous.stateTopic === (message.stateTopic || '')
        && previous.stateRetain === (message.stateRetain === true)
        && (previous.availabilityValue || 'online') === (message.availabilityValue === 'offline' ? 'offline' : 'online')
        && previous.availabilityRetain === true
        && JSON.stringify(previous.payload) === JSON.stringify(message.payload);
      if (unchanged && !force) continue;
      const discoveryChanged = previous && (previous.configTopic !== message.configTopic || previous.availabilityTopic !== message.availabilityTopic);
      const stateChanged = previous?.stateRetain && previous.stateTopic
        && (!message.stateRetain || previous.stateTopic !== message.stateTopic);
      const cleanupTopics = [...new Set(previous?.cleanupTopics || [])];
      if (discoveryChanged) {
        if (connected) {
          if (previous.configTopic && previous.configTopic !== message.configTopic) cleanupTopics.push(previous.configTopic);
          if (previous.availabilityTopic && previous.availabilityTopic !== message.availabilityTopic) cleanupTopics.push(previous.availabilityTopic);
        } else {
          cleanupTopics.push(previous.configTopic, previous.availabilityTopic);
        }
      }
      if (stateChanged) {
        if (connected) cleanupTopics.push(previous.stateTopic);
        else cleanupTopics.push(previous.stateTopic);
      }
      this.retainedDiscovery.set(key, {
        key,
        brokerId: message.brokerId || 'default',
        profileId: message.profileId || 'homeassistant',
        uniqueId: message.uniqueId || '',
        configTopic: message.configTopic,
        availabilityTopic: message.availabilityTopic || '',
        availabilityRetain: true,
        availabilityValue: message.availabilityValue === 'offline' ? 'offline' : 'online',
        payload: message.payload,
        stateTopic: message.stateTopic || '',
        stateRetain: message.stateRetain === true,
        statePayload: previous?.stateRetain && previous.stateTopic === message.stateTopic ? previous.statePayload : undefined,
        cleanupTopics,
        active: true
      });
      if (connected) {
        await this.publish(message.configTopic, message.payload, { retain: true }, message.brokerId);
        if (message.availabilityTopic) {
          await this.publish(
            message.availabilityTopic,
            message.availabilityValue === 'offline' ? 'offline' : 'online',
            { retain: true },
            message.brokerId
          );
        }
        // Publish the replacement first. Clearing the old topic beforehand
        // creates a visible Home Assistant gap and can temporarily remove
        // entities during broker reconnects or topic migrations. Never clear
        // the current discovery/availability topic after publishing it.
        const currentDiscoveryTopics = new Set([message.configTopic, message.availabilityTopic].filter(Boolean));
        for (const topic of new Set(cleanupTopics.filter((candidate) => candidate && !currentDiscoveryTopics.has(candidate)))) {
          await this.publish(topic, '', { retain: true }, message.brokerId);
        }
        cleanupTopics.length = 0;
        published += 1;
      } else {
        queued += 1;
      }
      changed = true;
    }
    if (changed) this.notifyRetainedDiscoveryChange();
    return { published, queued };
  }

  async removeDiscovery(messages) {
    let removed = 0;
    let queued = 0;
    for (const message of messages) {
      const key = retainedKey(message);
      const previous = this.retainedDiscovery.get(key);
      const entry = previous || {
        key,
        brokerId: message.brokerId || 'default',
        profileId: message.profileId || 'homeassistant',
        uniqueId: message.uniqueId || '',
        configTopic: message.configTopic,
        availabilityTopic: message.availabilityTopic || '',
        availabilityRetain: true,
        availabilityValue: message.availabilityValue === 'offline' ? 'offline' : 'online',
        payload: {},
        stateTopic: message.stateTopic || '',
        stateRetain: message.stateRetain === true || message.retainState === true,
        cleanupTopics: [],
        active: false
      };
      // A profile/schema can have changed since the last persisted registry
      // entry. Clear the topic from the current request as well as the
      // remembered entry so an old retained state cannot survive a toggle.
      if (message.stateTopic && message.stateTopic !== entry.stateTopic) {
        entry.cleanupTopics = [...new Set([...(entry.cleanupTopics || []), message.stateTopic])];
      }
      if (this.isBrokerConnected(entry.brokerId)) {
        await this.clearRetainedEntry(entry);
        this.retainedDiscovery.delete(key);
        removed += 1;
      } else {
        this.retainedDiscovery.set(key, { ...entry, active: false });
        queued += 1;
      }
    }
    if (messages.length) this.notifyRetainedDiscoveryChange();
    return { removed, queued };
  }

  async publishValues(messages) {
    let count = 0;
    let changed = false;
    for (const message of messages) {
      if (message.stateValue === undefined || message.stateValue === null || message.stateValue === '') continue;
      const payload = {
        ...(message.statePayload && typeof message.statePayload === 'object' ? message.statePayload : {}),
        value: message.stateValue,
        time: message.stateTime || new Date().toISOString()
      };
      const key = retainedKey(message);
      const entry = this.retainedDiscovery.get(key);
      // A value is only valid while its matching discovery is active. This
      // prevents an in-flight historical request from publishing an old
      // range after that range was disabled and its discovery was removed.
      if (!entry || entry.active === false || entry.availabilityValue === 'offline' || entry.stateTopic !== message.stateTopic) continue;
      if (entry?.stateRetain && message.stateRetain !== true) {
        await this.clearRetainedEntry(entry, { discovery: false, state: true });
        entry.stateRetain = false;
        entry.statePayload = undefined;
        changed = true;
      }
      await this.publish(message.stateTopic, payload, { retain: message.stateRetain === true }, message.brokerId);
      if (message.stateRetain === true) {
        if (entry) {
          entry.stateTopic = message.stateTopic;
          entry.stateRetain = true;
          entry.statePayload = payload;
          changed = true;
        }
      }
      count += 1;
    }
    if (changed) this.notifyRetainedDiscoveryChange();
    return count;
  }

  getSnapshot() {
    return {
      status: this.status,
      connected: this.connected,
      lastError: this.lastError,
      brokers: [...this.brokerStates.values()].map((state) => ({ ...state }))
    };
  }
}
