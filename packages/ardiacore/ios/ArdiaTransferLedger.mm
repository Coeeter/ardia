#import "ArdiaTransferLedger.h"

#include <os/lock.h>

@implementation ArdiaTransferLedger {
  os_unfair_lock _lock;
  NSInteger _lastGeneration;
  NSMutableDictionary<NSString *, NSNumber *> *_prepared;
  NSMutableDictionary<NSString *, NSNumber *> *_reloadHolds;
}

- (instancetype)init {
  if ((self = [super init])) {
    _lock = OS_UNFAIR_LOCK_INIT;
    _prepared = [NSMutableDictionary dictionary];
    _reloadHolds = [NSMutableDictionary dictionary];
  }
  return self;
}

- (NSInteger)locked:(NSInteger (^)(void))body {
  os_unfair_lock_lock(&_lock);
  const NSInteger result = body();
  os_unfair_lock_unlock(&_lock);
  return result;
}

- (NSInteger)prepare:(NSString *)key {
  return [self locked:^NSInteger {
    const NSInteger generation = ++self->_lastGeneration;
    self->_prepared[key] = @(generation);
    [self->_reloadHolds removeObjectForKey:key];
    return generation;
  }];
}

- (NSInteger)holdForReload:(NSString *)key {
  return [self locked:^NSInteger {
    const NSInteger generation = ++self->_lastGeneration;
    self->_prepared[key] = @(generation);
    self->_reloadHolds[key] = @(generation);
    return generation;
  }];
}

- (BOOL)isPrepared:(NSString *)key {
  return [self preparedGeneration:key] != 0;
}

- (NSInteger)preparedGeneration:(NSString *)key {
  return [self locked:^NSInteger {
    return self->_prepared[key].integerValue;
  }];
}

- (NSInteger)drop:(NSString *)key {
  return [self locked:^NSInteger {
    const NSInteger generation = self->_prepared[key].integerValue;
    [self->_prepared removeObjectForKey:key];
    [self->_reloadHolds removeObjectForKey:key];
    return generation;
  }];
}

- (BOOL)expireReloadHold:(NSString *)key generation:(NSInteger)generation {
  return [self locked:^NSInteger {
    if (self->_reloadHolds[key].integerValue != generation || self->_prepared[key].integerValue != generation) return NO;
    [self->_reloadHolds removeObjectForKey:key];
    [self->_prepared removeObjectForKey:key];
    return YES;
  }];
}

@end
