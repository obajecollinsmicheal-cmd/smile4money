#![no_std]

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, Address, Env, Map, Symbol, Vec,
};

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
pub enum Error {
    Unauthorized = 1,
    ContractPaused = 2,
    MaxEventsReached = 3,
    ContractNotFound = 4,
    AlreadyRegistered = 5,
}

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Admin = 0,
    Paused = 1,
    MaxEvents = 2,
    Registrations = 3,
    Events = 4,
}

#[contracttype]
#[derive(Clone)]
pub struct ContractRecord {
    pub registrant: Address,
    pub contract_id: Symbol,
    pub active: bool,
}

#[contract]
pub struct ContractRegistry;

#[contractimpl]
impl ContractRegistry {
    pub fn initialize(env: Env, admin: Address, max_events: u32) -> Result<(), Error> {
        if env.storage().instance().has(&DataKey::Admin) {
            return Err(Error::Unauthorized);
        }

        admin.require_auth();
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::Paused, &false);
        env.storage()
            .instance()
            .set(&DataKey::MaxEvents, &max_events);
        env.storage().instance().set(
            &DataKey::Registrations,
            &Map::<Symbol, ContractRecord>::new(&env),
        );
        env.storage()
            .instance()
            .set(&DataKey::Events, &Vec::<Symbol>::new(&env));

        Ok(())
    }

    pub fn pause(env: Env, caller: Address) -> Result<(), Error> {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(Error::Unauthorized)?;
        if admin != caller {
            return Err(Error::Unauthorized);
        }
        caller.require_auth();
        env.storage().instance().set(&DataKey::Paused, &true);
        Ok(())
    }

    pub fn unpause(env: Env, caller: Address) -> Result<(), Error> {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(Error::Unauthorized)?;
        if admin != caller {
            return Err(Error::Unauthorized);
        }
        caller.require_auth();
        env.storage().instance().set(&DataKey::Paused, &false);
        Ok(())
    }

    pub fn register_contract(env: Env, caller: Address, contract_id: Symbol) -> Result<(), Error> {
        Self::ensure_not_paused(&env)?;
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(Error::Unauthorized)?;
        if admin != caller {
            return Err(Error::Unauthorized);
        }
        caller.require_auth();

        let mut registrations: Map<Symbol, ContractRecord> = env
            .storage()
            .instance()
            .get(&DataKey::Registrations)
            .unwrap();
        if registrations.contains_key(contract_id.clone()) {
            return Err(Error::AlreadyRegistered);
        }

        registrations.set(
            contract_id.clone(),
            ContractRecord {
                registrant: caller.clone(),
                contract_id: contract_id.clone(),
                active: true,
            },
        );
        env.storage()
            .instance()
            .set(&DataKey::Registrations, &registrations);
        Ok(())
    }

    pub fn update_contract(env: Env, caller: Address, contract_id: Symbol) -> Result<(), Error> {
        Self::ensure_not_paused(&env)?;
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(Error::Unauthorized)?;
        if admin != caller {
            return Err(Error::Unauthorized);
        }
        caller.require_auth();

        let registrations: Map<Symbol, ContractRecord> = env
            .storage()
            .instance()
            .get(&DataKey::Registrations)
            .unwrap_or_else(|| Map::new(&env));
        if !registrations.contains_key(contract_id.clone()) {
            return Err(Error::ContractNotFound);
        }
        Ok(())
    }

    pub fn deregister_contract(
        env: Env,
        caller: Address,
        contract_id: Symbol,
    ) -> Result<(), Error> {
        Self::ensure_not_paused(&env)?;
        let mut registrations: Map<Symbol, ContractRecord> = env
            .storage()
            .instance()
            .get(&DataKey::Registrations)
            .unwrap_or_else(|| Map::new(&env));
        let record = registrations
            .get(contract_id.clone())
            .ok_or(Error::ContractNotFound)?;
        let is_registrant = record.registrant == caller;
        if !is_registrant {
            let admin: Address = env
                .storage()
                .instance()
                .get(&DataKey::Admin)
                .ok_or(Error::Unauthorized)?;
            if admin != caller {
                return Err(Error::Unauthorized);
            }
        }
        caller.require_auth();
        registrations.remove(contract_id.clone());
        env.storage()
            .instance()
            .set(&DataKey::Registrations, &registrations);
        Ok(())
    }

    pub fn submit_event(env: Env, caller: Address, event_name: Symbol) -> Result<(), Error> {
        Self::ensure_not_paused(&env)?;
        caller.require_auth();
        let max_events: u32 = env
            .storage()
            .instance()
            .get(&DataKey::MaxEvents)
            .unwrap_or(0);
        let mut events: Vec<Symbol> = env
            .storage()
            .instance()
            .get(&DataKey::Events)
            .unwrap_or_else(|| Vec::new(&env));
        if events.len() >= max_events {
            return Err(Error::MaxEventsReached);
        }
        events.push_back(event_name);
        env.storage().instance().set(&DataKey::Events, &events);
        Ok(())
    }

    fn ensure_not_paused(env: &Env) -> Result<(), Error> {
        let paused: bool = env
            .storage()
            .instance()
            .get(&DataKey::Paused)
            .unwrap_or(false);
        if paused {
            return Err(Error::ContractPaused);
        }
        Ok(())
    }
}

#[cfg(test)]
mod test;
